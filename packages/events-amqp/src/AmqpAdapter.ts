/**
 * AMQP/RabbitMQ adapter for `@connectum/events`.
 *
 * Implements the {@link EventAdapter} interface on top of AMQP 0-9-1 (RabbitMQ),
 * providing at-least-once delivery with topic exchanges, consumer groups via
 * named queues, dead-letter exchange support, explicit external topology,
 * automatic connection recovery (amqplib opt-in recovery), and per-message
 * publisher confirms with `mandatory`/`basic.return` correlation.
 *
 * @module AmqpAdapter
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import type amqp from "amqplib";
import type { AmqpTopologyObject } from "./errors.ts";
import { AmqpConnectionError, AmqpPublishNackError, AmqpPublishTimeoutError, AmqpSerializationError, AmqpTopologyError, AmqpUnroutableError } from "./errors.ts";
import type { AmqpAdapterOptions, AmqpLifecycleCallbacks, AmqpLifecycleEvent, AmqpQueueOverride, AmqpRecoveryOptions } from "./types.ts";
import { AmqpTopologyMode } from "./types.ts";

/** Default exchange name when none is provided. */
const DEFAULT_EXCHANGE = "connectum.events";

/** Default exchange type. */
const DEFAULT_EXCHANGE_TYPE = "topic";

/** Default prefetch count. */
const DEFAULT_PREFETCH = 10;

/** Default contentType message property. */
const DEFAULT_CONTENT_TYPE = "application/protobuf";

/** Default broker-outcome deadline for a single publish (ms). */
const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Private header used to correlate `basic.return` frames to publishes when
 * `mandatory: true` (the return frame carries no deliveryTag). Visible on
 * the wire — documented for external contracts; disable via
 * `publisherOptions.correlationHeader: false` (switches to single-flight).
 */
const PUBLISH_ID_HEADER = "x-connectum-publish-id";

/**
 * Convert an EventBus wildcard pattern to an AMQP routing key pattern.
 *
 * EventBus uses NATS-style wildcards:
 * - `*` matches a single token (same in AMQP topic exchange)
 * - `>` matches one or more tokens (AMQP uses `#`)
 *
 * @param pattern - EventBus wildcard pattern
 * @returns AMQP routing key pattern
 */
export function toAmqpPattern(pattern: string): string {
    return pattern.replace(/>/g, "#");
}

/**
 * Distinguish a connection/channel loss from a genuine broker nack in a
 * publisher-confirm error.
 *
 * amqplib rejects every outstanding (unconfirmed) publish with
 * `Error("channel closed")` when the channel or connection drops
 * (`lib/channel.js` close handler), whereas a real negative ack surfaces as
 * `Error("message nacked")`. A connection loss is NOT a broker nack, so it
 * must reject the publish with `AmqpConnectionError`, matching the documented
 * contract ("in-flight publishes reject with AmqpConnectionError on
 * connection loss").
 *
 * NOTE: this is a text-based FALLBACK. amqplib provides no `.code` at the
 * confirm callback to distinguish a nacked from a closed channel, so the
 * primary signal is the structural per-channel close flag tracked by
 * {@link trackChannelClose} and consumed by {@link classifyConfirmError}; this
 * regex only catches the residual case where the channel reference still
 * matches but the error text indicates a close.
 */
export function isConnectionLostError(err: unknown): boolean {
    return err instanceof Error && /channel closed|connection closed|closed unexpectedly/i.test(err.message);
}

/**
 * Classify a publisher-confirm failure into a typed error.
 *
 * A connection/channel loss MUST reject with {@link AmqpConnectionError} (the
 * message state is unknown → republish-safe); a genuine broker nack is
 * {@link AmqpPublishNackError}. The decision is driven by STRUCTURAL signals the
 * adapter owns — the publish is closing, the confirm channel emitted `close`, or
 * it was swapped by recovery — with {@link isConnectionLostError} kept only as a
 * defense-in-depth fallback for the error text.
 */
export function classifyConfirmError(params: {
    readonly err: unknown;
    readonly closing: boolean;
    readonly channelClosed: boolean;
    readonly channelSwapped: boolean;
    readonly routingKey: string;
}): AmqpConnectionError | AmqpPublishNackError {
    const { err, closing, channelClosed, channelSwapped, routingKey } = params;
    if (closing || channelClosed || channelSwapped || isConnectionLostError(err)) {
        return new AmqpConnectionError("Connection lost while awaiting publish confirm", { cause: err });
    }
    return new AmqpPublishNackError(`Broker nacked message for routing key '${routingKey}'`, { cause: err });
}

/** Minimal channel surface needed to record a `close` before amqplib's drain. */
interface AmqpChannelCloseSource {
    prependListener(event: "close", listener: () => void): unknown;
}

/**
 * Record a confirm channel as closed BEFORE amqplib drains its unconfirmed
 * publishes.
 *
 * amqplib registers a `close` listener in the `Channel` constructor that fails
 * every outstanding confirm with `Error("channel closed")` (amqplib
 * `lib/channel.js`). Listeners run in registration order, so we MUST
 * `prependListener` to set the flag first — otherwise the confirm callback would
 * observe it unset. Consumed by {@link classifyConfirmError}.
 */
export function trackChannelClose<C extends AmqpChannelCloseSource>(ch: C, closed: WeakSet<C>): void {
    ch.prependListener("close", () => {
        closed.add(ch);
    });
}

/**
 * Replicate amqplib 2.x's recovery delay formula (`lib/recovery.js`
 * `calculateDelay` + `normaliseRecoveryOptions` defaults): an exponential base
 * capped at `maxDelay` BEFORE symmetric jitter — the delay is uniform in
 * `[base × (1 − jitter), base × (1 + jitter)]`, floored at 0, rounded.
 * Kept formula-identical so the bounded initial phase (#198) backs off exactly
 * like amqplib's steady-state recovery; pinned by unit tests. `random` is
 * injectable for cross-runtime-deterministic tests. Exported (not via the
 * package barrel) for direct unit testing.
 */
export function computeRecoveryDelay(
    recovery: Pick<AmqpRecoveryOptions, "initialDelay" | "maxDelay" | "factor" | "jitter">,
    attempt: number,
    random: () => number = Math.random,
): number {
    // amqplib routes every knob through toFiniteNumber(value, fallback):
    // NaN/Infinity fall back to the defaults instead of propagating.
    const finite = (value: number | undefined, fallback: number): number => (Number.isFinite(value as number) ? (value as number) : fallback);
    const initialDelay = Math.max(0, finite(recovery.initialDelay, 100));
    const maxDelay = Math.max(initialDelay, finite(recovery.maxDelay, 30_000));
    const factor = Math.max(1, finite(recovery.factor, 2));
    const jitter = Math.min(1, Math.max(0, finite(recovery.jitter, 0.2)));
    const base = Math.min(maxDelay, initialDelay * factor ** (attempt - 1));
    const jitterPart = base * jitter;
    const offset = jitterPart > 0 ? random() * jitterPart * 2 - jitterPart : 0;
    return Math.max(0, Math.round(base + offset));
}

/** AMQP reply codes that identify DETERMINISTIC topology drift (vs a transient failure). */
const FATAL_TOPOLOGY_REPLY_CODES: ReadonlySet<number> = new Set([404, 406]);

/**
 * Decide whether a setup failure is deterministic topology drift.
 *
 * The gate reads the AMQP reply code of the CAUSE (amqplib sets `error.code`
 * to the reply code on channel/connection errors): `404` NOT_FOUND / `406`
 * PRECONDITION_FAILED are deterministic — retrying cannot succeed until the
 * config or broker topology changes. `instanceof AmqpTopologyError` alone is
 * NOT a valid gate: the adapter wraps ANY setup-pass cause into it, including
 * transient ones (320 connection-forced, 541 internal-error, 405 resource
 * locked, a mid-setup connection drop). Exported (not via the package barrel)
 * for direct cross-runtime unit testing.
 */
export function isDeterministicTopologyDrift(err: unknown): boolean {
    if (!(err instanceof AmqpTopologyError)) {
        return false;
    }
    const cause = err.cause as { code?: unknown; message?: unknown } | null | undefined;
    if (typeof cause?.code !== "number" || !FATAL_TOPOLOGY_REPLY_CODES.has(cause.code)) {
        return false;
    }
    // RabbitMQ cluster caveat: a classic queue whose home node is down rejects
    // declare/check with 404 whose reply text names the condition ("home node
    // ... is down or inaccessible"). That outage is TRANSIENT (the node can
    // come back) — not config drift; it must stay in recovery. Text fallback,
    // mirroring isConnectionLostError's defense-in-depth role.
    if (cause.code === 404 && typeof cause.message === "string" && /down or inaccessible/i.test(cause.message)) {
        return false;
    }
    return true;
}

/** Side effects the recovery-lifecycle wiring needs from the adapter closure. */
interface RecoveryLifecycleHooks {
    readonly clearPublishChannel: () => void;
    readonly failPendingReturns: () => void;
    readonly nextReconnectAttempt: () => number;
    readonly resetReconnectAttempt: () => void;
    /**
     * Policy gate for `connect-failed`: `true` = this failure is fatal — stop
     * the recovery cycle now. The wiring then calls {@link enterFatalState}
     * and reports the terminal `reconnect-failed` event.
     */
    readonly fatalTopologyGate: (err: Error) => boolean;
    /**
     * Deterministically stop the recovery cycle and tear down adapter state.
     * MUST run synchronously enough that the wrapper's `_scheduleReconnect`
     * (which amqplib calls right after emitting `connect-failed`) observes the
     * stopped state and schedules nothing.
     */
    readonly enterFatalState: (err: Error) => void;
    /**
     * `true` while the adapter's own `disconnect()` is in progress — a fatal
     * classification racing a graceful shutdown must not fire terminal events
     * after the caller already asked to stop.
     */
    readonly isClosing: () => boolean;
    /**
     * Deliver a `connected` event exactly once per successful (re)connect.
     * Owned by the adapter so the initial-vs-reconnect flag does not depend on
     * amqplib's emit-before-resolve ordering: the first delivery (from either
     * the wrapper's `connect` event or the post-resolve fallback) is
     * `reconnected: false`, every later one is `reconnected: true`.
     */
    readonly deliverConnected: () => void;
}

/** Structural subset of an amqplib recovering connection (or a Node EventEmitter). */
interface AmqpRecoveryEmitter {
    // biome-ignore lint/suspicious/noExplicitAny: matches Node's EventEmitter.on listener signature
    on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Deliver one lifecycle event to the union callback and its legacy flat shim.
 *
 * `onLifecycle` is the primary surface and receives every event; the flat
 * callbacks are a compatibility shim over the same stream (deprecated since
 * 1.3.0). `blocked`/`unblocked` have no flat equivalent. Exported (not via the
 * package barrel) for direct cross-runtime unit testing.
 *
 * User callbacks MUST NOT throw; a thrown exception is isolated here. This is
 * a hard requirement, not politeness: dispatch runs inside amqplib's recovery
 * emitter handlers, where a synchronous throw would be caught by
 * `_connect()`'s try block (closing a just-established healthy connection and
 * scheduling a pointless reconnect — endless connect/close churn), or would
 * escape from the model `close` handler BEFORE `_scheduleReconnect` runs
 * (killing recovery entirely). Isolation also keeps the shim contract: a
 * throwing `onLifecycle` does not starve the flat callbacks, and vice versa.
 */
export function dispatchLifecycle(lifecycle: AmqpLifecycleCallbacks | undefined, event: AmqpLifecycleEvent): void {
    if (!lifecycle) {
        return;
    }
    try {
        lifecycle.onLifecycle?.(event);
    } catch {
        // Isolated — see the JSDoc contract above.
    }
    try {
        switch (event.type) {
            case "connected":
                lifecycle.onConnected?.();
                break;
            case "disconnected":
                lifecycle.onDisconnected?.(event.error);
                break;
            case "reconnecting":
                lifecycle.onReconnecting?.({ attempt: event.attempt, delay: event.delay, error: event.error });
                break;
            case "reconnect-failed":
                lifecycle.onReconnectFailed?.(event.error);
                break;
            case "setup-failed":
                lifecycle.onSetupFailed?.(event.error, { initial: event.initial, attempt: event.attempt });
                break;
            default:
                // blocked / unblocked: union-only observability.
                break;
        }
    } catch {
        // Isolated — see the JSDoc contract above.
    }
}

/** Wire broker flow-control events (`connection.blocked`/`unblocked`) to the lifecycle surface. */
function wireFlowControlEvents(conn: AmqpRecoveryEmitter, lifecycle: AmqpLifecycleCallbacks | undefined): void {
    conn.on("blocked", (reason: unknown) => {
        dispatchLifecycle(lifecycle, { type: "blocked", reason: String(reason ?? "") });
    });
    conn.on("unblocked", () => {
        dispatchLifecycle(lifecycle, { type: "unblocked" });
    });
}

/**
 * Wire the amqplib recovery lifecycle events to the public lifecycle surface.
 *
 * `reconnecting` is driven SOLELY by `reconnect-scheduled` (it fires once per
 * scheduled retry). amqplib emits `connect-failed` AND `reconnect-scheduled` for
 * the same failed attempt, so also mapping `connect-failed` to `reconnecting`
 * would double-count; `connect-failed` only clears the half-open publish channel
 * and (for a topology error) reports `setup-failed`. The terminal,
 * retries-exhausted case is `reconnect-failed`.
 *
 * `disconnected` is driven SOLELY by the wrapper's `disconnect` event. The raw
 * connection `error` re-emit is deliberately NOT mapped: a socket-level cut
 * emits `error` AND `close` (→ `disconnect`), so mapping both would double-fire
 * (fixed in 1.3.0; pinned by the exactly-once integration tests).
 *
 * `connected` delivery goes through {@link RecoveryLifecycleHooks.deliverConnected},
 * which owns the initial-vs-reconnect flag — exactly-once regardless of
 * whether amqplib emits the initial `connect` before or after this wiring is
 * attached (today it is before; pinned by the exactly-once integration test).
 */
export function wireRecoveryLifecycle(conn: AmqpRecoveryEmitter, lifecycle: AmqpLifecycleCallbacks | undefined, hooks: RecoveryLifecycleHooks): void {
    conn.on("connect", () => {
        hooks.resetReconnectAttempt();
        hooks.deliverConnected();
    });
    conn.on("disconnect", (err: Error) => {
        hooks.failPendingReturns();
        dispatchLifecycle(lifecycle, { type: "disconnected", error: err });
    });
    conn.on("reconnect-scheduled", (info: { attempt: number; delay: number; error: Error }) => {
        dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: info.attempt, delay: info.delay, error: info.error });
    });
    conn.on("connect-failed", (err: Error) => {
        hooks.clearPublishChannel();
        const attempt = hooks.nextReconnectAttempt();
        if (err instanceof AmqpTopologyError) {
            dispatchLifecycle(lifecycle, { type: "setup-failed", initial: false, attempt, error: err });
        }
        if (!hooks.isClosing() && hooks.fatalTopologyGate(err)) {
            // Deterministic drift + opt-in policy: stop the cycle NOW. amqplib
            // calls _scheduleReconnect right after emitting connect-failed, so
            // the teardown (wrapper close()) must flip its stopped flag
            // synchronously within this handler — then no further retry is
            // scheduled and no reconnect-scheduled event follows (pinned by
            // the fatal-drift integration test). Skipped while the adapter's
            // own disconnect() runs: a racing failure must not fire terminal
            // events after the caller already asked to stop.
            hooks.enterFatalState(err);
            dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: err });
        }
    });
    conn.on("reconnect-failed", (err: Error) => {
        hooks.clearPublishChannel();
        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: err });
    });
    wireFlowControlEvents(conn, lifecycle);
}

/**
 * Parse AMQP message headers into a `Map<string, string>`.
 *
 * Only string-coercible values are included. All headers are passed
 * through; internal EventBus headers (`x-event-id`, `x-published-at`)
 * are removed by the consumer callback after extraction.
 */
function parseHeaders(headers: Record<string, unknown> | undefined): Map<string, string> {
    const map = new Map<string, string>();
    if (!headers) {
        return map;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && value !== null) {
            map.set(key, String(value));
        }
    }
    return map;
}

/** Internal record of an active subscription, replayable after recovery. */
interface SubscriptionRecord {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
    readonly subOptions: RawSubscribeOptions | undefined;
    /** Channel of the CURRENT incarnation (replaced on recovery). */
    channel: amqp.Channel | null;
    consumerTag: string | null;
    queueName: string;
    isAutoGroup: boolean;
    active: boolean;
}

/** Pending mandatory publish awaiting its confirm, keyed by publish id. */
interface PendingReturn {
    returned: boolean;
}

/**
 * Create an AMQP/RabbitMQ adapter for @connectum/events.
 *
 * @param options - AMQP adapter configuration
 * @returns EventAdapter instance
 *
 * @example
 * ```typescript
 * import { AmqpAdapter } from "@connectum/events-amqp";
 * import { createEventBus } from "@connectum/events";
 *
 * const bus = createEventBus({
 *     adapter: AmqpAdapter({ url: "amqp://guest:guest@localhost:5672" }),
 *     routes: [myRoutes],
 * });
 * await bus.start();
 * ```
 *
 * @example External AMQP contract (AsyncAPI-style)
 * ```typescript
 * const adapter = AmqpAdapter({
 *     url: "amqp://broker:5672",
 *     exchange: "partner.direct",
 *     exchangeType: "direct",
 *     serialization: { contentType: "application/json" },
 *     topology: {
 *         queues: [{
 *             name: "partner.inbound.v1",
 *             durable: true,
 *             arguments: {
 *                 "x-dead-letter-exchange": "partner.dlx",
 *                 "x-dead-letter-routing-key": "inbound.dead",
 *             },
 *         }],
 *         bindings: [{ queue: "partner.inbound.v1", source: "partner.direct", routingKey: "inbound" }],
 *     },
 *     queueOverrides: { partner: { queue: "partner.inbound.v1" } },
 *     // externalContract: emit only contract-specified properties (no envelope).
 *     publisherOptions: { persistent: true, mandatory: true, externalContract: true },
 * });
 * ```
 */
export function AmqpAdapter(options: AmqpAdapterOptions): EventAdapter {
    const exchange = options.exchange ?? DEFAULT_EXCHANGE;
    const exchangeType = options.exchangeType ?? DEFAULT_EXCHANGE_TYPE;
    const topologyMode = options.topologyMode ?? AmqpTopologyMode.ASSERT;
    const contentType = options.serialization?.contentType ?? DEFAULT_CONTENT_TYPE;
    const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    // External-contract publishing suppresses the EventBus envelope (see
    // AmqpPublisherOptions.externalContract). It also forces single-flight
    // mandatory correlation so no `x-connectum-publish-id` header reaches the
    // wire — `correlationHeader` is ignored in this mode.
    const externalContract = options.publisherOptions?.externalContract ?? false;
    const correlationHeader = externalContract ? false : (options.publisherOptions?.correlationHeader ?? true);
    const lifecycle = options.lifecycle;

    /** The recovering connection wrapper (amqplib opt-in recovery) or a plain connection. */
    let connection: amqp.ChannelModel | null = null;
    let publishChannel: amqp.ConfirmChannel | null = null;
    let closing = false;

    /** Reconnect attempt counter (own; never read from amqplib internals). */
    let reconnectAttempt = 0;

    /**
     * Confirm channels observed closed, recorded BEFORE amqplib drains their
     * unconfirmed publishes — the structural signal {@link classifyConfirmError}
     * uses to tell a connection loss from a broker nack.
     */
    const closedPublishChannels = new WeakSet<amqp.ConfirmChannel>();

    /** Pending mandatory publishes awaiting confirm (publish-id → return flag). */
    const pendingReturns = new Map<string, PendingReturn>();

    /** Single-flight chain for mandatory publishes when the header is disabled. */
    let mandatoryChain: Promise<unknown> = Promise.resolve();

    /** Replayable registry of subscriptions (source of truth across recoveries). */
    const subscriptionRecords: SubscriptionRecord[] = [];

    /** Wrap a broker/channel error into AmqpTopologyError with context. */
    function topologyError(message: string, cause: unknown, object?: AmqpTopologyObject): AmqpTopologyError {
        const text = `${message}: ${cause instanceof Error ? cause.message : String(cause)}`;
        return object !== undefined ? new AmqpTopologyError(text, { cause, object }) : new AmqpTopologyError(text, { cause });
    }

    /**
     * Run one topology operation; a failure is wrapped into AmqpTopologyError
     * carrying the identity of the object being declared/verified — known
     * structurally at the call site, so consumers never parse broker-reply text.
     */
    async function topologyOp<T>(message: string, object: AmqpTopologyObject, op: () => Promise<T>): Promise<T> {
        try {
            return await op();
        } catch (err) {
            if (err instanceof AmqpTopologyError) {
                throw err;
            }
            throw topologyError(message, err, object);
        }
    }

    /**
     * Apply declarative topology on a channel according to `topologyMode`.
     *
     * In `check` mode only existence is verifiable (checkExchange/checkQueue);
     * argument equivalence and bindings cannot be passively inspected (AMQP
     * has no introspection — a conflicting redeclare is PRECONDITION_FAILED).
     */
    async function applyTopology(ch: amqp.ConfirmChannel | amqp.Channel): Promise<void> {
        if (topologyMode === AmqpTopologyMode.SKIP) {
            return;
        }

        const topo = options.topology;

        if (topologyMode === AmqpTopologyMode.CHECK) {
            const CHECK_MSG = "Topology check failed (missing broker object)";
            // Outer catch preserves the pre-1.3.0 guarantee that ANY throw in
            // this block (incl. loop headers / property reads on a pathological
            // topology object) surfaces as AmqpTopologyError; the per-op
            // wrappers add the failing object's identity on top.
            try {
                await topologyOp(CHECK_MSG, { kind: "exchange", name: exchange }, () => ch.checkExchange(exchange));
                for (const ex of topo?.exchanges ?? []) {
                    await topologyOp(CHECK_MSG, { kind: "exchange", name: ex.name }, () => ch.checkExchange(ex.name));
                }
                for (const q of topo?.queues ?? []) {
                    await topologyOp(CHECK_MSG, { kind: "queue", name: q.name }, () => ch.checkQueue(q.name));
                }
            } catch (err) {
                if (err instanceof AmqpTopologyError) {
                    throw err;
                }
                throw topologyError(CHECK_MSG, err);
            }
            return;
        }

        // assert mode — one topologyOp per declared object, so a failure
        // carries the failing object's identity (#202). The outer catch
        // preserves the pre-1.3.0 guarantee that ANY throw in this block
        // surfaces as AmqpTopologyError.
        const ASSERT_MSG = "Topology declaration failed";
        try {
            await topologyOp(ASSERT_MSG, { kind: "exchange", name: exchange }, () =>
                ch.assertExchange(exchange, exchangeType, {
                    durable: options.exchangeOptions?.durable ?? true,
                    autoDelete: options.exchangeOptions?.autoDelete ?? false,
                }),
            );

            for (const ex of topo?.exchanges ?? []) {
                await topologyOp(ASSERT_MSG, { kind: "exchange", name: ex.name }, () =>
                    ch.assertExchange(ex.name, ex.type, {
                        durable: ex.durable ?? true,
                        autoDelete: ex.autoDelete ?? false,
                        arguments: ex.arguments,
                    }),
                );
            }
            for (const q of topo?.queues ?? []) {
                await topologyOp(ASSERT_MSG, { kind: "queue", name: q.name }, () =>
                    ch.assertQueue(q.name, {
                        durable: q.durable ?? true,
                        autoDelete: q.autoDelete ?? false,
                        exclusive: q.exclusive ?? false,
                        arguments: q.arguments,
                    }),
                );
            }
            for (const b of topo?.bindings ?? []) {
                const queueDest = b.queue;
                const exchangeDest = b.exchange;
                if (queueDest !== undefined) {
                    await topologyOp(ASSERT_MSG, { kind: "binding", source: b.source, destination: queueDest, destinationType: "queue", routingKey: b.routingKey }, () =>
                        ch.bindQueue(queueDest, b.source, b.routingKey, b.arguments),
                    );
                } else if (exchangeDest !== undefined) {
                    await topologyOp(ASSERT_MSG, { kind: "binding", source: b.source, destination: exchangeDest, destinationType: "exchange", routingKey: b.routingKey }, () =>
                        ch.bindExchange(exchangeDest, b.source, b.routingKey, b.arguments),
                    );
                } else {
                    // Config-validation error: the binding's destination is the
                    // missing piece, so no AmqpTopologyObject identity is
                    // representable — this is the one adapter-thrown
                    // AmqpTopologyError without `object` (documented).
                    throw topologyError(ASSERT_MSG, new Error(`Binding for source '${b.source}' must declare either 'queue' or 'exchange'`));
                }
            }
        } catch (err) {
            if (err instanceof AmqpTopologyError) {
                throw err;
            }
            throw topologyError(ASSERT_MSG, err);
        }
    }

    /**
     * Clear pending mandatory-return tracking on connection loss.
     *
     * The publish promises themselves settle through the confirm callback:
     * amqplib fires every outstanding confirm with `Error("channel closed")`
     * when the channel drops, which {@link isConnectionLostError} classifies
     * as `AmqpConnectionError`. This only drops the now-stale return-id map.
     */
    function failPendingReturns(): void {
        pendingReturns.clear();
    }

    /**
     * (Re)create the publish channel with its `return` listener.
     * Called on every successful (re)connect via the recovery setup hook.
     */
    async function setupPublishChannel(model: amqp.ChannelModel): Promise<void> {
        const ch = await model.createConfirmChannel();

        // Mark the channel closed BEFORE amqplib drains outstanding confirms, so
        // a connection loss is classified structurally (see classifyConfirmError).
        trackChannelClose(ch, closedPublishChannels);

        ch.on("return", (msg: amqp.ConsumeMessage) => {
            const id = (msg.properties.headers as Record<string, unknown> | undefined)?.[PUBLISH_ID_HEADER];
            if (typeof id === "string") {
                const pending = pendingReturns.get(id);
                if (pending) {
                    pending.returned = true;
                }
                return;
            }
            // Single-flight mode: at most one mandatory publish is outstanding —
            // mark the only pending record.
            for (const pending of pendingReturns.values()) {
                pending.returned = true;
            }
        });

        ch.on("error", () => {
            // Channel-level errors surface through the connection lifecycle
            // and through rejected confirm callbacks; nothing to do here, but
            // the listener prevents unhandled 'error' crashes.
        });

        publishChannel = ch;
    }

    /** Start (or re-start after recovery) a consumer for a subscription record. */
    async function startConsumer(model: amqp.ChannelModel, record: SubscriptionRecord): Promise<void> {
        const group = record.subOptions?.group;
        const isAutoGroup = !group;
        const override: AmqpQueueOverride | undefined = group ? options.queueOverrides?.[group] : undefined;

        let ch: amqp.Channel;
        try {
            ch = await model.createChannel();
        } catch (err) {
            // A subscribe() parked in the recovering wrapper's waiter queue is
            // rejected with amqplib's plain Error("Connection closed") when the
            // cycle dies (fatal topology stop, disconnect, budget exhaustion).
            // Keep the documented typed-error taxonomy at this public boundary.
            if (isConnectionLostError(err)) {
                throw new AmqpConnectionError("Connection lost while establishing consumer channel", { cause: err });
            }
            throw err;
        }
        ch.on("error", () => {
            // Prevent unhandled 'error' events on consumer channels; failures
            // surface through recovery or through nacked deliveries.
        });

        const prefetch = options.consumerOptions?.prefetch ?? DEFAULT_PREFETCH;
        await ch.prefetch(prefetch);

        // Resolve queue name: explicit override → external contract queue;
        // named group → `${exchange}.${group}`; no group → exclusive auto queue.
        const queueName = override?.queue ?? (group ? `${exchange}.${group}` : `${exchange}.sub-${randomUUID()}`);

        // A queue declared in the explicit topology was already asserted with
        // its full arguments by applyTopology — re-asserting it here without
        // those arguments would be PRECONDITION_FAILED (406). Only bind.
        const declaredInTopology = options.topology?.queues?.some((q) => q.name === queueName) ?? false;

        if (topologyMode === AmqpTopologyMode.ASSERT && declaredInTopology) {
            try {
                for (const amqpPattern of record.patterns.map(toAmqpPattern)) {
                    await topologyOp(
                        `Failed to bind topology-declared queue '${queueName}'`,
                        { kind: "binding", source: exchange, destination: queueName, destinationType: "queue", routingKey: amqpPattern },
                        () => ch.bindQueue(queueName, exchange, amqpPattern),
                    );
                }
            } catch (err) {
                await ch.close().catch(() => undefined);
                // Pre-1.3.0, ANY throw here (incl. pattern mapping) was wrapped;
                // preserve that error-class contract.
                throw err instanceof AmqpTopologyError ? err : topologyError(`Failed to bind topology-declared queue '${queueName}'`, err, { kind: "queue", name: queueName });
            }
        } else if (topologyMode === AmqpTopologyMode.ASSERT) {
            // Build queue arguments: global defaults + per-override arguments
            const queueArgs: Record<string, unknown> = {};
            if (options.queueOptions?.messageTtl !== undefined) {
                queueArgs["x-message-ttl"] = options.queueOptions.messageTtl;
            }
            if (options.queueOptions?.maxLength !== undefined) {
                queueArgs["x-max-length"] = options.queueOptions.maxLength;
            }
            if (options.queueOptions?.deadLetterExchange !== undefined) {
                queueArgs["x-dead-letter-exchange"] = options.queueOptions.deadLetterExchange;
            }
            if (options.queueOptions?.deadLetterRoutingKey !== undefined) {
                queueArgs["x-dead-letter-routing-key"] = options.queueOptions.deadLetterRoutingKey;
            }
            if (override?.arguments) {
                Object.assign(queueArgs, override.arguments);
            }

            const queueDurable = override?.durable ?? options.queueOptions?.durable ?? true;
            const exclusive = options.consumerOptions?.exclusive ?? false;

            try {
                await topologyOp(`Failed to declare queue '${queueName}'`, { kind: "queue", name: queueName }, () =>
                    ch.assertQueue(queueName, {
                        durable: group ? queueDurable : false,
                        autoDelete: isAutoGroup,
                        exclusive: isAutoGroup ? exclusive : false,
                        arguments: Object.keys(queueArgs).length > 0 ? queueArgs : undefined,
                    }),
                );

                for (const amqpPattern of record.patterns.map(toAmqpPattern)) {
                    await topologyOp(
                        `Failed to declare queue '${queueName}'`,
                        { kind: "binding", source: exchange, destination: queueName, destinationType: "queue", routingKey: amqpPattern },
                        () => ch.bindQueue(queueName, exchange, amqpPattern),
                    );
                }
            } catch (err) {
                await ch.close().catch(() => undefined);
                // Pre-1.3.0, ANY throw here (incl. pattern mapping) was wrapped;
                // preserve that error-class contract.
                throw err instanceof AmqpTopologyError ? err : topologyError(`Failed to declare queue '${queueName}'`, err, { kind: "queue", name: queueName });
            }
        } else if (topologyMode === AmqpTopologyMode.CHECK) {
            try {
                await topologyOp(`Queue '${queueName}' does not exist (topologyMode: "check")`, { kind: "queue", name: queueName }, () => ch.checkQueue(queueName));
            } catch (err) {
                await ch.close().catch(() => undefined);
                throw err;
            }
        }
        // skip mode: no checks — a missing queue fails on consume below.

        const decode = options.serialization?.decode;

        let consumeResult: amqp.Replies.Consume;
        try {
            consumeResult = await ch.consume(
                queueName,
                (msg: amqp.ConsumeMessage | null) => {
                    if (!msg) {
                        // Consumer cancelled by broker
                        return;
                    }

                    const msgHeaders = parseHeaders(msg.properties.headers as Record<string, unknown> | undefined);

                    const eventId = msgHeaders.get("x-event-id") ?? msg.properties.messageId ?? randomUUID();

                    const publishedAtStr = msgHeaders.get("x-published-at");
                    const publishedAt = publishedAtStr ? new Date(publishedAtStr) : msg.properties.timestamp ? new Date(msg.properties.timestamp * 1000) : new Date();

                    // Remove internal headers from metadata
                    msgHeaders.delete("x-event-id");
                    msgHeaders.delete("x-published-at");
                    msgHeaders.delete(PUBLISH_ID_HEADER);

                    let payload: Uint8Array;
                    try {
                        payload = decode ? decode(new Uint8Array(msg.content)) : new Uint8Array(msg.content);
                    } catch {
                        // Decode failure — reject without requeue (DLX or drop):
                        // a payload that cannot be decoded will never succeed.
                        ch.nack(msg, false, false);
                        return;
                    }

                    // Attempt: redelivered = at least 2nd delivery
                    const attempt = msg.fields.redelivered ? 2 : 1;

                    const rawEvent: RawEvent = {
                        eventId,
                        eventType: msg.fields.routingKey,
                        payload,
                        publishedAt: Number.isFinite(publishedAt.getTime()) ? publishedAt : new Date(),
                        attempt,
                        metadata: msgHeaders,
                    };

                    const ack = async (): Promise<void> => {
                        ch.ack(msg);
                    };
                    const nack = async (requeue?: boolean): Promise<void> => {
                        if (requeue === false) {
                            // Reject without requeue — goes to DLX or is discarded
                            ch.nack(msg, false, false);
                        } else {
                            // Reject with requeue
                            ch.nack(msg, false, true);
                        }
                    };

                    record.handler(rawEvent, ack, nack).catch(() => {
                        // Handler error — nack for redelivery
                        ch.nack(msg, false, true);
                    });
                },
                { noAck: false },
            );
        } catch (err) {
            await ch.close().catch(() => undefined);
            throw topologyError(`Failed to consume from queue '${queueName}'`, err, { kind: "queue", name: queueName });
        }

        record.channel = ch;
        record.consumerTag = consumeResult.consumerTag;
        record.queueName = queueName;
        record.isAutoGroup = isAutoGroup;
    }

    /**
     * Recovery setup hook: runs on EVERY successful (re)connect before the
     * wrapper reports the connection ready. Re-creates the publish channel,
     * re-applies topology, and replays active subscriptions.
     */
    async function onSetup(model: amqp.ChannelModel): Promise<void> {
        failPendingReturns();
        await setupPublishChannel(model);
        await applyTopology(publishChannel as amqp.ConfirmChannel);

        for (const record of subscriptionRecords) {
            if (record.active) {
                await startConsumer(model, record);
            }
        }
    }

    return {
        name: "amqp",

        async connect(context?: AdapterContext): Promise<void> {
            if (connection) {
                throw new AmqpConnectionError("AmqpAdapter: already connected");
            }
            closing = false;
            // A fresh connect() starts a fresh attempt series — a stale counter
            // from a previous exhausted-recovery incarnation must not leak into
            // this incarnation's setup-failed attempt numbers.
            reconnectAttempt = 0;

            // Dynamic import to avoid top-level require issues with ESM
            const amqplib = await import("amqplib");

            const clientProperties: Record<string, string> = {};
            if (context?.serviceName) {
                clientProperties.connection_name = context.serviceName;
            }

            const recoveryEnabled = options.recovery !== false;
            const recoveryOpts = typeof options.recovery === "object" ? options.recovery : {};

            const connectOptions: Record<string, unknown> = {
                ...options.socketOptions,
            };
            if (Object.keys(clientProperties).length > 0) {
                connectOptions.clientProperties = clientProperties;
            }
            if (recoveryEnabled) {
                // amqplib opt-in recovery: reconnect with backoff+jitter; our
                // setup hook re-creates channels/topology/subscriptions.
                connectOptions.recovery = {
                    initialDelay: recoveryOpts.initialDelay,
                    maxDelay: recoveryOpts.maxDelay,
                    factor: recoveryOpts.factor,
                    jitter: recoveryOpts.jitter,
                    maxRetries: recoveryOpts.maxRetries,
                    setup: onSetup,
                };
            }

            // #198: an explicit finite initialConnectMaxRetries activates the
            // adapter-owned bounded initial phase (the probe below folds into
            // it — validation IS each attempt, no extra connects).
            const initialBudgetRaw = recoveryOpts.initialConnectMaxRetries;
            // A negative value clamps to 0 (single attempt), mirroring
            // amqplib's own maxRetries normalization; non-finite = unset.
            const initialBudget = typeof initialBudgetRaw === "number" && Number.isFinite(initialBudgetRaw) ? Math.max(0, Math.floor(initialBudgetRaw)) : null;

            if (recoveryEnabled && initialBudget !== null) {
                // Adapter-owned bounded initial-connect phase: amqplib's own
                // initial loop runs before any lifecycle wiring can attach and
                // never rejects under maxRetries=Infinity, so the adapter owns
                // the window up to the first successful validation. Each
                // attempt is a throwaway non-recovering connect + full setup
                // pass with per-attempt lifecycle events; budget exhaustion
                // rejects connect() typed instead of blocking forever.
                // N retries = N+1 attempts, mirroring maxRetries semantics.
                const phaseOptions: Record<string, unknown> = { ...options.socketOptions };
                if (Object.keys(clientProperties).length > 0) {
                    phaseOptions.clientProperties = clientProperties;
                }

                for (let attempt = 0; ; attempt += 1) {
                    let candidate: amqp.ChannelModel | null = null;
                    let failure: Error | null = null;
                    try {
                        candidate = (await amqplib.connect(options.url, phaseOptions)) as amqp.ChannelModel;
                        // A drop mid-setup must not crash via unhandled 'error'.
                        candidate.on("error", () => undefined);
                        await onSetup(candidate);
                    } catch (err) {
                        failure = err instanceof Error ? err : new Error(String(err));
                    }
                    if (candidate) {
                        // Success or failure, the validation connection is
                        // discarded — the recovering connect below re-runs
                        // onSetup (re-creating publishChannel) before
                        // connect() resolves.
                        await candidate.close().catch(() => undefined);
                    }
                    publishChannel = null;

                    if (failure === null) {
                        break; // broker reachable + topology valid → hand off
                    }

                    // A disconnect() racing the phase wins BEFORE any events:
                    // its own teardown (e.g. closing the candidate's publish
                    // channel mid-setup) can masquerade as a topology failure,
                    // which must not surface as setup-failed or trip fail-fast.
                    if (closing) {
                        throw new AmqpConnectionError("Adapter closed during the initial connect phase", { cause: failure });
                    }

                    if (failure instanceof AmqpTopologyError) {
                        dispatchLifecycle(lifecycle, { type: "setup-failed", initial: true, attempt, error: failure });
                        if (options.failFastOnInitialSetupError) {
                            throw failure;
                        }
                    }

                    if (attempt >= initialBudget) {
                        // Budget exhausted: terminal and typed — never a
                        // silent block (the failure mode #198 exists to kill).
                        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: failure });
                        throw new AmqpConnectionError(`Initial connect failed after ${attempt + 1} attempt(s) (initialConnectMaxRetries: ${initialBudget})`, { cause: failure });
                    }

                    const delay = computeRecoveryDelay(recoveryOpts, attempt + 1);
                    dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: attempt + 1, delay, error: failure });
                    // Interruptible backoff: a disconnect() during the phase
                    // must not park for a full 30s+ delay.
                    for (let waited = 0; waited < delay && !closing; waited += 100) {
                        await new Promise<void>((resolve) => {
                            globalThis.setTimeout(resolve, Math.min(100, delay - waited));
                        });
                    }
                    if (closing) {
                        throw new AmqpConnectionError("Adapter closed during the initial connect phase", { cause: failure });
                    }
                }
            }

            // Optional fail-fast / observability probe: validate topology against
            // a throwaway NON-recovering connection BEFORE entering amqplib's
            // recovery loop, which never rejects connect() under the default
            // maxRetries=Infinity (so a permanent topology error would otherwise
            // hang connect() forever, silently). Runs only when opted in. A broker
            // that is merely unreachable here is transient (fall through to
            // recovery); only a deterministic AmqpTopologyError fails fast.
            // Skipped when the bounded initial phase above ran — validation
            // already happened as part of its attempts.
            if (recoveryEnabled && initialBudget === null && (options.failFastOnInitialSetupError || lifecycle?.onSetupFailed || lifecycle?.onLifecycle)) {
                const probeOptions: Record<string, unknown> = { ...options.socketOptions };
                if (Object.keys(clientProperties).length > 0) {
                    probeOptions.clientProperties = clientProperties;
                }

                let probe: amqp.ChannelModel | null = null;
                try {
                    probe = (await amqplib.connect(options.url, probeOptions)) as amqp.ChannelModel;
                    // A broker drop while the probe runs its setup pass must
                    // not crash the process via an unhandled 'error' event —
                    // the drop surfaces as an onSetup rejection instead.
                    probe.on("error", () => undefined);
                } catch {
                    // Broker unreachable at startup — not a deterministic setup error.
                    probe = null;
                }

                if (probe) {
                    try {
                        await onSetup(probe);
                    } catch (err) {
                        await probe.close().catch(() => undefined);
                        publishChannel = null;
                        if (err instanceof AmqpTopologyError) {
                            dispatchLifecycle(lifecycle, { type: "setup-failed", initial: true, attempt: 0, error: err });
                            if (options.failFastOnInitialSetupError) {
                                throw err;
                            }
                        }
                        // Non-topology error, or fail-fast disabled: fall through
                        // to the real recovering connect below.
                        probe = null;
                    }

                    if (probe) {
                        // Topology validated; discard the probe. The real recovering
                        // connection re-runs onSetup (re-creating publishChannel)
                        // before connect() returns.
                        await probe.close().catch(() => undefined);
                        publishChannel = null;
                    }
                }
            }

            // A disconnect() that raced the initial phase/probe must win here:
            // opening the recovering connection after disconnect() resolved
            // would leak it alive forever (nothing would ever close it) and
            // dispatch lifecycle events after the caller asked to stop.
            if (closing) {
                throw new AmqpConnectionError("Adapter closed while connect() was in progress");
            }

            const conn = (await amqplib.connect(options.url, connectOptions)) as amqp.ChannelModel;

            if (recoveryEnabled) {
                // A lost connection is reported SOLELY via the wrapper's
                // `disconnect` event (see wireRecoveryLifecycle) — mapping the
                // re-emitted raw `error` too double-fired `disconnected` on a
                // socket-level cut (fixed in 1.3.0). The no-op listener must
                // stay: an unhandled EventEmitter `error` crashes the process.
                conn.on("error", () => undefined);

                // Exactly-once `connected`, ordering-independent: the first
                // delivery (wherever it comes from) is the initial connect.
                // Today amqplib emits the initial `connect` before connect()
                // resolves — i.e. before the wiring below attaches — so the
                // post-wiring fallback delivers it; if a future amqplib emits
                // it after attach, the wrapper listener delivers it instead
                // and the fallback no-ops.
                let connectedDelivered = false;
                const deliverConnected = (): void => {
                    const reconnected = connectedDelivered;
                    connectedDelivered = true;
                    dispatchLifecycle(lifecycle, { type: "connected", reconnected });
                };

                wireRecoveryLifecycle(conn, lifecycle, {
                    clearPublishChannel: () => {
                        publishChannel = null;
                    },
                    failPendingReturns,
                    nextReconnectAttempt: () => {
                        reconnectAttempt += 1;
                        return reconnectAttempt;
                    },
                    resetReconnectAttempt: () => {
                        reconnectAttempt = 0;
                    },
                    deliverConnected,
                    fatalTopologyGate: (err) => options.treatTopologyErrorAsFatal === true && isDeterministicTopologyDrift(err),
                    enterFatalState: () => {
                        // Wrapper close() sets its stopped flag synchronously
                        // (before the first await in RecoveringCore.close), so
                        // amqplib's _scheduleReconnect — called right after
                        // this handler — schedules nothing.
                        void conn.close().catch(() => undefined);
                        connection = null;
                        publishChannel = null;
                        // The cycle is dead — so are its consumers. Mirror
                        // disconnect()'s bookkeeping (no network calls: the
                        // channels died with the model) so a later connect()
                        // starts from a clean slate instead of silently
                        // resurrecting stale subscriptions.
                        for (const record of subscriptionRecords) {
                            record.active = false;
                            record.channel = null;
                            record.consumerTag = null;
                        }
                        subscriptionRecords.length = 0;
                        failPendingReturns();
                    },
                    isClosing: () => closing,
                });

                // With recovery, the wrapper already ran onSetup before resolving.
                connection = conn;
                if (!connectedDelivered) {
                    deliverConnected();
                }
                return;
            }

            // recovery: false — legacy single-shot connection. Surface
            // connection lifecycle; never console-only. Without a recovery
            // wrapper there is no `disconnect` event; `close` is the single
            // disconnect signal. An `error`, when the loss is abnormal, always
            // precedes `close` in amqplib and is kept as the cause — while a
            // server-forced graceful close (e.g. 320 connection-forced) emits
            // only `close` and must still surface as `disconnected`
            // (1.3.0 contract fix: exactly once per drop in this mode too).
            let lastConnError: Error | null = null;
            let setupFailedClose = false;
            conn.on("error", (err: Error) => {
                lastConnError = err;
            });
            wireFlowControlEvents(conn, lifecycle);
            conn.on("close", () => {
                connection = null;
                publishChannel = null;
                failPendingReturns();
                // Not a "loss" when the adapter itself is closing (disconnect())
                // or discarding a connection whose setup failed (the caller
                // gets the thrown error instead).
                if (!closing && !setupFailedClose) {
                    dispatchLifecycle(lifecycle, { type: "disconnected", error: lastConnError ?? new Error("Connection closed") });
                }
            });

            try {
                await onSetup(conn);
                connection = conn;
                dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
            } catch (err) {
                setupFailedClose = true;
                await conn.close().catch(() => undefined);
                publishChannel = null;
                throw err;
            }
        },

        async disconnect(): Promise<void> {
            closing = true;

            // Unsubscribe all active subscriptions first (with error isolation).
            for (const record of subscriptionRecords) {
                if (record.active && record.channel) {
                    if (record.consumerTag) {
                        await record.channel.cancel(record.consumerTag).catch(() => undefined);
                    }
                    if (record.isAutoGroup) {
                        await record.channel.deleteQueue(record.queueName).catch(() => undefined);
                    }
                    await record.channel.close().catch(() => undefined);
                }
                record.active = false;
                record.channel = null;
                record.consumerTag = null;
            }
            subscriptionRecords.length = 0;

            if (publishChannel) {
                await publishChannel.close().catch(() => undefined);
                publishChannel = null;
            }

            if (connection) {
                await connection.close().catch(() => undefined);
                connection = null;
            }
            failPendingReturns();
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            const ch = publishChannel;
            if (!ch || closing) {
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }

            const routingKey = eventType;
            const eventId = randomUUID();

            // Build headers: user metadata first, then internal
            const headers: Record<string, string> = {};

            if (publishOptions?.metadata) {
                for (const [key, value] of Object.entries(publishOptions.metadata)) {
                    // Skip only internal EventBus headers to prevent spoofing
                    if (key === "x-event-id" || key === "x-published-at" || key === PUBLISH_ID_HEADER) {
                        continue;
                    }
                    headers[key] = String(value);
                }
            }

            // External-contract mode emits no EventBus envelope: the wire carries
            // only the caller's contract-specified headers. Otherwise stamp the
            // envelope (stripped again on delivery in subscribe()).
            if (!externalContract) {
                headers["x-event-id"] = eventId;
                headers["x-published-at"] = new Date().toISOString();
            }

            const persistent = options.publisherOptions?.persistent ?? true;
            const mandatory = options.publisherOptions?.mandatory ?? false;

            let body: Buffer;
            try {
                const encode = options.serialization?.encode;
                const encoded = encode ? encode(payload) : payload;
                body = Buffer.from(encoded);
            } catch (err) {
                throw new AmqpSerializationError(`Payload encoding failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }

            // basic.return correlation (mandatory only): header stamping by
            // default; single-flight serialization when the header is disabled.
            // Frame ordering alone is NOT reliable — returns carry no
            // deliveryTag and confirms of other messages may interleave.
            const publishId: string | null = mandatory ? eventId : null;
            if (mandatory && correlationHeader) {
                headers[PUBLISH_ID_HEADER] = eventId;
            }

            // messageId / timestamp: a caller-supplied value (PublishOptions)
            // always wins; otherwise auto-populate in normal mode and OMIT in
            // external-contract mode (the contract owns them). Keys are omitted
            // entirely when undefined (exactOptionalPropertyTypes).
            const resolvedMessageId = publishOptions?.messageId ?? (externalContract ? undefined : eventId);
            const resolvedTimestamp = publishOptions?.timestamp ?? (externalContract ? undefined : Math.trunc(Date.now() / 1000));
            const publishProps: amqp.Options.Publish = {
                persistent,
                mandatory,
                headers,
                contentType,
                ...(resolvedMessageId !== undefined ? { messageId: resolvedMessageId } : {}),
                ...(resolvedTimestamp !== undefined ? { timestamp: resolvedTimestamp } : {}),
            };

            const doPublish = async (): Promise<void> => {
                const pending: PendingReturn = { returned: false };
                if (publishId !== null) {
                    pendingReturns.set(publishId, pending);
                }

                try {
                    await new Promise<void>((resolve, reject) => {
                        let settled = false;
                        const settle = (fn: () => void): void => {
                            if (!settled) {
                                settled = true;
                                clearTimeout(timer);
                                fn();
                            }
                        };

                        const timer = setTimeout(() => {
                            settle(() =>
                                reject(new AmqpPublishTimeoutError(`No broker outcome within ${publishTimeoutMs}ms for routing key '${routingKey}' (message state UNKNOWN)`)),
                            );
                        }, publishTimeoutMs);

                        let written: boolean;
                        try {
                            written = ch.publish(exchange, routingKey, body, publishProps, (err) => {
                                // Per-message confirm callback (ack/nack). The broker
                                // guarantees basic.return arrives BEFORE the confirm of
                                // the same message — check the return flag first.
                                settle(() => {
                                    if (err) {
                                        // A dropped channel/connection (recovery may not yet
                                        // have swapped publishChannel) is a connection loss,
                                        // not a broker nack — classify by the structural
                                        // close signal, with the text regex as a fallback.
                                        reject(
                                            classifyConfirmError({
                                                err,
                                                closing,
                                                channelClosed: closedPublishChannels.has(ch),
                                                channelSwapped: publishChannel !== ch,
                                                routingKey,
                                            }),
                                        );
                                    } else if (pending.returned) {
                                        reject(new AmqpUnroutableError(`Message unroutable (mandatory): no queue bound for routing key '${routingKey}'`, routingKey));
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        } catch (err) {
                            settle(() => reject(new AmqpConnectionError(`Publish failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })));
                            return;
                        }

                        // Back-pressure: the in-memory buffer is full. The confirm
                        // callback still fires; nothing extra to await here.
                        void written;
                    });
                } finally {
                    if (publishId !== null) {
                        pendingReturns.delete(publishId);
                    }
                }
            };

            // Confirms are always per-message: every publish resolves on its
            // own broker ack (or rejects with a typed error).
            if (mandatory && !correlationHeader) {
                // Single-flight: serialize mandatory publishes so the headerless
                // return frame is unambiguously the outstanding one.
                const run = mandatoryChain.then(doPublish, doPublish);
                mandatoryChain = run.catch(() => undefined);
                return run;
            }

            return doPublish();
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            if (!connection) {
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }

            const record: SubscriptionRecord = {
                patterns,
                handler,
                subOptions,
                channel: null,
                consumerTag: null,
                queueName: "",
                isAutoGroup: !subOptions?.group,
                active: true,
            };

            await startConsumer(connection, record);
            subscriptionRecords.push(record);

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    record.active = false;

                    const ch = record.channel;
                    if (ch) {
                        if (record.consumerTag) {
                            await ch.cancel(record.consumerTag).catch(() => undefined);
                        }

                        // Delete auto-generated queues to prevent broker-side leak
                        if (record.isAutoGroup) {
                            await ch.deleteQueue(record.queueName).catch(() => undefined);
                        }

                        // Do not unbind patterns for named groups — the queue is durable
                        // and shared across multiple consumers. Unbinding would break
                        // delivery to other active consumers on the same group.

                        await ch.close().catch(() => undefined);
                    }
                    record.channel = null;
                    record.consumerTag = null;

                    const idx = subscriptionRecords.indexOf(record);
                    if (idx !== -1) {
                        subscriptionRecords.splice(idx, 1);
                    }
                },
            };

            return subscription;
        },
    };
}
