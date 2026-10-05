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
import type {
    AmqpAdapterOptions,
    AmqpConsumerLossCause,
    AmqpLifecycleCallbacks,
    AmqpLifecycleEvent,
    AmqpQueueOverride,
    AmqpRecoveryOptions,
    AmqpSettlementAction,
} from "./types.ts";
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

/** amqplib routes every recovery knob through `toFiniteNumber(value, fallback)`: NaN/Infinity fall back to the default. */
function finiteOr(value: number | undefined, fallback: number): number {
    return Number.isFinite(value as number) ? (value as number) : fallback;
}

/** The `maxDelay` the delay formula actually applies: the default when unset, never below `initialDelay`. */
export function effectiveRecoveryMaxDelay(recovery: Pick<AmqpRecoveryOptions, "initialDelay" | "maxDelay">): number {
    const initialDelay = Math.max(0, finiteOr(recovery.initialDelay, 100));
    return Math.max(initialDelay, finiteOr(recovery.maxDelay, 30_000));
}

/**
 * Replicate amqplib's built-in recovery delay (amqplib ≥ 2.2.0
 * `lib/recovery.js`: `calculateBuiltinDelay` with the
 * `normaliseRecoveryOptions` defaults and fallbacks). The exponential base is
 * capped at `maxDelay / (1 + jitter)`, so even the largest jitter offset lands
 * exactly on `maxDelay`: the delay is uniform in
 * `[base × (1 − jitter), base × (1 + jitter)]`, rounded, floored at 0, and
 * never exceeds `maxDelay` (up to rounding when `maxDelay` is not an integer)
 * with no pile-up of draws on the cap.
 *
 * Kept formula-identical because the adapter's own delay site, `publishRetry`,
 * must back off exactly like amqplib's connection recovery, which the adapter
 * does not compute itself. amqplib does not export its function, so unit
 * tests pin this copy at the boundaries. `random` is injectable for
 * cross-runtime-deterministic tests. Exported (not via the package barrel)
 * for direct unit testing.
 */
export function computeRecoveryDelay(
    recovery: Pick<AmqpRecoveryOptions, "initialDelay" | "maxDelay" | "factor" | "jitter">,
    attempt: number,
    random: () => number = Math.random,
): number {
    const initialDelay = Math.max(0, finiteOr(recovery.initialDelay, 100));
    const maxDelay = effectiveRecoveryMaxDelay(recovery);
    const factor = Math.max(1, finiteOr(recovery.factor, 2));
    const jitter = Math.min(1, Math.max(0, finiteOr(recovery.jitter, 0.2)));
    const cappedBase = maxDelay / (1 + jitter);
    const base = Math.min(cappedBase, initialDelay * factor ** (attempt - 1));
    const jitterPart = base * jitter;
    const offset = jitterPart > 0 ? random() * jitterPart * 2 - jitterPart : 0;
    return Math.max(0, Math.round(base + offset));
}

/**
 * Normalize `recovery.initialConnectMaxRetries` into the retry budget the
 * adapter forwards to amqplib, or `null` when the option counts as unset.
 *
 * amqplib reads the value itself differently: `NaN` falls back to
 * `maxRetries`, `Infinity` becomes an unbounded initial loop, and a fraction
 * behaves as its ceiling (it gives up when the attempt count reaches the
 * budget). The documented contract is "a finite N gives `max(0, floor(N)) + 1`
 * attempts; anything that is not a finite number is unset", so the adapter
 * normalizes first and forwards only an integer, or nothing. Exported (not via
 * the package barrel) for direct unit testing.
 */
export function normalizeInitialConnectBudget(raw: unknown): number | null {
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : null;
}

/**
 * Build the `recovery` option object handed to amqplib's `connect()`.
 *
 * With an initial connect budget the adapter forwards it as amqplib's
 * `initialMaxRetries` and asks for `waitForConnect: false`: amqplib then
 * returns the recovering connection before its first attempt, so the
 * adapter's lifecycle wiring sees every attempt of the initial window. Without
 * a budget neither key is set, and amqplib keeps its default of resolving only
 * after the first successful connect. Exported (not via the package barrel)
 * for direct unit testing of what reaches amqplib.
 */
export function buildRecoveryConnectOptions(params: {
    readonly recovery: AmqpRecoveryOptions;
    readonly setup: (model: amqp.ChannelModel) => Promise<void>;
    readonly initialBudget: number | null;
    /** The guarded `recovery.backoff` ({@link createBackoffGuard}); absent = amqplib's built-in delay. */
    readonly calculateDelay?: ((attempt: number) => number) | undefined;
}): Record<string, unknown> {
    const { recovery, setup, initialBudget, calculateDelay } = params;
    const forwarded: Record<string, unknown> = {
        initialDelay: recovery.initialDelay,
        maxDelay: recovery.maxDelay,
        factor: recovery.factor,
        jitter: recovery.jitter,
        maxRetries: recovery.maxRetries,
        setup,
    };
    if (initialBudget !== null) {
        forwarded.initialMaxRetries = initialBudget;
        forwarded.waitForConnect = false;
    }
    if (calculateDelay !== undefined) {
        forwarded.calculateDelay = calculateDelay;
    }
    return forwarded;
}

/** The numeric delay knobs amqplib ignores once `calculateDelay` is set. */
const DELAY_KNOBS = ["initialDelay", "maxDelay", "factor", "jitter"] as const;

/**
 * Reject `recovery.backoff` combined with a numeric delay knob. With a custom
 * delay function amqplib does not read `initialDelay`, `maxDelay`, `factor`
 * or `jitter` at all, so accepting the pair would leave a configured value
 * silently without effect.
 */
function rejectBackoffWithDelayKnobs(recovery: AmqpAdapterOptions["recovery"]): void {
    if (typeof recovery !== "object" || recovery.backoff === undefined) {
        return;
    }
    for (const knob of DELAY_KNOBS) {
        if (recovery[knob] !== undefined) {
            throw new TypeError(
                `AmqpAdapter: recovery.backoff cannot be combined with recovery.${knob} — the delay knobs have no effect once a backoff hook is set; compute the delay (and its cap) inside the hook`,
            );
        }
    }
}

/** A `recovery.backoff` wrapped for amqplib, with the state needed to explain a give-up. */
export interface BackoffGuard {
    /** Forwarded to amqplib as `calculateDelay`. */
    readonly calculateDelay: (attempt: number) => number;
    /** Remember the latest connection error; the give-up message names it. */
    noteConnectionError(err: Error): void;
    /** The typed give-up error once the hook has failed, else `null`. The same object on every call. */
    giveUpError(): AmqpConnectionError | null;
}

/**
 * Wrap a user `recovery.backoff` before handing it to amqplib as
 * `calculateDelay`.
 *
 * amqplib 2.2.0 gives recovery up when `calculateDelay` throws or returns
 * anything but a finite number ≥ 0, and reports only that error: the
 * connection error that led to the retry is dropped, and nothing but message
 * text tells a hook failure from an exhausted budget. The wrapper therefore
 * validates the return itself and records the first failure, so the adapter
 * can surface the give-up as a typed `AmqpConnectionError` carrying the
 * hook's error as `cause` and naming the last connection error — decided by
 * recorded state, never by parsing amqplib's message.
 *
 * A thenable return (an `async` hook) is a failure too: amqplib calls the hook
 * synchronously and would reject it with an unclear "got [object Promise]".
 * A no-op rejection handler is attached so a later rejection of that Promise
 * cannot surface as an unhandled rejection. Exported (not via the package
 * barrel) for direct unit testing.
 */
export function createBackoffGuard(backoff: (attempt: number) => number): BackoffGuard {
    let lastConnectionError: Error | null = null;
    let failure: { readonly attempt: number; readonly error: Error } | null = null;
    let typed: AmqpConnectionError | null = null;

    const fail = (attempt: number, error: Error): Error => {
        failure ??= { attempt, error };
        return error;
    };

    return {
        calculateDelay(attempt: number): number {
            let value: unknown;
            try {
                value = backoff(attempt);
            } catch (err) {
                throw fail(attempt, err instanceof Error ? err : new Error(`recovery.backoff threw ${String(err)}`, { cause: err }));
            }
            if (typeof (value as { then?: unknown } | null)?.then === "function") {
                (value as PromiseLike<unknown>).then(undefined, () => undefined);
                throw fail(attempt, new Error(`recovery.backoff must be synchronous: attempt ${attempt} returned a Promise`));
            }
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                const shown = typeof value === "string" ? `the string '${value}'` : String(value);
                throw fail(attempt, new Error(`recovery.backoff must return a finite, non-negative number of milliseconds: attempt ${attempt} returned ${shown}`));
            }
            return value;
        },
        noteConnectionError(err: Error): void {
            lastConnectionError = err;
        },
        giveUpError(): AmqpConnectionError | null {
            if (failure === null) {
                return null;
            }
            typed ??= new AmqpConnectionError(
                `Recovery gave up: recovery.backoff failed at attempt ${failure.attempt} (${failure.error.message}); last connection error: ${lastConnectionError?.message ?? "none observed"}`,
                { cause: failure.error },
            );
            return typed;
        },
    };
}

/**
 * Assemble amqplib connect options from socket options + client properties.
 * Single builder for both connect sites (the adapter's connection and the
 * startup probe) so they cannot silently diverge.
 */
function buildConnectOptions(socketOptions: Record<string, unknown> | undefined, clientProperties: Record<string, string>): Record<string, unknown> {
    const opts: Record<string, unknown> = { ...socketOptions };
    if (Object.keys(clientProperties).length > 0) {
        opts.clientProperties = clientProperties;
    }
    return opts;
}

/**
 * The publish AUTO-RETRY boundary (#195): which publish failures the opt-in
 * `publishRetry` retries inline.
 *
 * Deliberately NARROWER than the at-least-once REPUBLISH matrix in the error
 * taxonomy (`errors.ts`): a broker nack is republish-safe by policy but is an
 * explicit refusal — hammering it in a tight loop is not a retry strategy.
 * Connection-class outcomes (`AmqpConnectionError`: publish during recovery,
 * in-flight confirm lost to a drop) are retriable; a timeout
 * (`AmqpPublishTimeoutError`, state UNKNOWN) joins only via
 * `retryOnTimeout: true`. Deterministic outcomes (unroutable, serialization,
 * topology) never retry.
 */
export function isAutoRetriablePublishError(err: unknown, options?: { readonly retryOnTimeout?: boolean }): boolean {
    if (err instanceof AmqpConnectionError) {
        return true;
    }
    return options?.retryOnTimeout === true && err instanceof AmqpPublishTimeoutError;
}

/**
 * Broker reply texts (by AMQP reply code) that identify DETERMINISTIC topology
 * drift: the condition cannot heal without a configuration or topology change.
 * Verified against RabbitMQ 3.13 and 4.2 (identical texts). A `404` the broker
 * raises for a self-healing queue condition (home node down or inaccessible,
 * queue process crashed / stopped by its supervisor, timeout, leader stopping
 * or being demoted) and a `406` "exchange limit reached" (clears when
 * exchanges are removed) are deliberately absent.
 */
const FATAL_TOPOLOGY_REPLY_TEXTS: ReadonlyMap<number, RegExp> = new Map([
    [404, /no queue '|no exchange '/],
    [406, /inequivalent arg|invalid arg|unknown exchange type|invalid exchange type/],
]);

/**
 * Decide whether a setup failure is deterministic topology drift.
 *
 * The gate reads the broker reply of the CAUSE: amqplib sets `error.code` to
 * the AMQP reply code on channel/connection errors and ends the message with
 * the reply text. Only a code AND a text from {@link FATAL_TOPOLOGY_REPLY_TEXTS}
 * are fatal — retrying cannot succeed until the config or broker topology
 * changes. A recognised code with an unrecognised text, and a reply without
 * text, stay in recovery: that errs toward retrying (visible through
 * `reconnecting` / `setup-failed`) rather than toward a silent permanent stop.
 * `instanceof AmqpTopologyError` alone is NOT a valid gate: the adapter wraps
 * ANY setup-pass cause into it, including transient ones (320 connection-forced,
 * 541 internal-error, 405 resource locked, a mid-setup connection drop).
 * Exported (not via the package barrel) for direct cross-runtime unit testing.
 */
export function isDeterministicTopologyDrift(err: unknown): boolean {
    if (!(err instanceof AmqpTopologyError)) {
        return false;
    }
    const cause = err.cause as { code?: unknown; message?: unknown } | null | undefined;
    if (typeof cause?.code !== "number" || typeof cause.message !== "string") {
        return false;
    }
    return FATAL_TOPOLOGY_REPLY_TEXTS.get(cause.code)?.test(cause.message) ?? false;
}

/**
 * Pick the error reported by `disconnected` when `recovery: false` loses its
 * connection. An earlier connection `error` wins, then the error amqplib hands
 * to `close` (a server-forced close carries its reply `code` there), then a
 * synthetic error for a close that came with no cause at all.
 * Exported (not via the package barrel) for direct cross-runtime unit testing.
 */
export function resolveDisconnectCause(lastConnError: Error | null, closeCause: unknown): Error {
    return lastConnError ?? (closeCause instanceof Error ? closeCause : new Error("Connection closed"));
}

/**
 * Whether the publish attempt that just failed hit a channel the broker closed
 * with a reply code (404 missing exchange, 403 internal exchange, 406, 541, ...)
 * and that channel is still the current one. The connection stays up, so
 * recovery never recreates it and a retry would meet the same closed channel.
 * Keyed on channel identity rather than a code list: any reply code kills a
 * channel the same way, a connection loss closes channels with no reply code,
 * and a code that arrived on a channel recovery has already replaced is
 * retriable.
 * Exported (not via the package barrel) for direct cross-runtime unit testing.
 */
export function isBrokerClosedCurrentChannel(
    attemptChannel: amqp.ConfirmChannel | null,
    currentChannel: amqp.ConfirmChannel | null,
    channelErrors: WeakMap<amqp.ConfirmChannel, Error>,
): boolean {
    if (attemptChannel === null || attemptChannel !== currentChannel) {
        return false;
    }
    const channelError = channelErrors.get(attemptChannel) as { code?: unknown } | undefined;
    return typeof channelError?.code === "number";
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
     * Forget a cycle that amqplib itself abandoned (`reconnect-failed` after
     * the retry budget ran out). amqplib has already stopped the wrapper, so
     * nothing is closed here; the adapter only drops its references so later
     * operations take the typed "not connected" paths and a new `connect()`
     * starts clean.
     */
    readonly markCycleDead: () => void;
    /**
     * `true` while the adapter's own `disconnect()` is in progress, or once
     * this connection was abandoned — a fatal classification racing a
     * graceful shutdown must not fire terminal events after the caller
     * already asked to stop, and a late failure of an abandoned connection
     * must not touch the state of a newer one.
     */
    readonly isClosing: () => boolean;
    /**
     * `true` until `connect()` has handed the connection to the caller. A
     * failure in this window belongs to the initial connect: it reports
     * `setup-failed { initial: true }` with the attempt index, is subject to
     * the startup fail-fast policy instead of the steady-state fatal gate,
     * and never counts as a reconnect attempt.
     */
    readonly isInitialWindow: () => boolean;
    /** Count one failed attempt of the initial window and return its 0-based index. */
    readonly nextInitialAttempt: () => number;
    /**
     * Policy gate for a failed attempt of the initial window: `true` = stop
     * the initial connect now (startup fail-fast on a setup error).
     */
    readonly initialFailFastGate: (err: Error) => boolean;
    /**
     * Stop the initial connect so that `connect()` rejects with `err`. Like
     * {@link enterFatalState} it MUST stop the wrapper synchronously: amqplib
     * schedules the next attempt right after emitting `connect-failed`.
     */
    readonly stopInitialConnect: (err: Error) => void;
    /** Remember a connection error (`disconnect`, `connect-failed`) so a later give-up can name it. */
    readonly noteConnectionError: (err: Error) => void;
    /**
     * The error the terminal `reconnect-failed` event reports for amqplib's
     * give-up error: the typed backoff-hook failure when the hook caused the
     * give-up, otherwise amqplib's error unchanged.
     */
    readonly mapGiveUpError: (err: Error) => Error;
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
 * A callback failure is isolated here, whether it is a synchronous throw or a
 * rejected returned promise. This is a hard requirement, not politeness:
 * dispatch runs inside amqplib's recovery emitter handlers, where a
 * synchronous throw would be caught by `_connect()`'s try block (closing a
 * just-established healthy connection and scheduling a pointless reconnect —
 * endless connect/close churn), or would escape from the model `close`
 * handler BEFORE `_scheduleReconnect` runs (killing recovery entirely), and an
 * unobserved rejection would crash the process via `unhandledRejection`.
 * Isolation also keeps the shim contract: a failing `onLifecycle` does not
 * starve the flat callbacks, and vice versa. A returned promise is attached to
 * but never awaited — awaiting would let a slow callback delay recovery.
 *
 * Each isolated failure is reported to `onLifecycle` as a `lifecycle-error`
 * event. A failure while handling `lifecycle-error` itself is dropped: the
 * report path must not recurse.
 */
export function dispatchLifecycle(lifecycle: AmqpLifecycleCallbacks | undefined, event: AmqpLifecycleEvent): void {
    if (!lifecycle) {
        return;
    }
    const invoke = (callback: string, call: () => void | Promise<void>): void => {
        const report = (error: unknown): void => {
            if (event.type === "lifecycle-error") {
                return;
            }
            dispatchLifecycle(lifecycle, {
                type: "lifecycle-error",
                callback,
                event: event.type,
                error: error instanceof Error ? error : new Error(String(error), { cause: error }),
            });
        };
        try {
            const result: unknown = call();
            // A callable `then` rather than `instanceof Promise`: a promise from
            // another realm or a userland thenable must be isolated too.
            if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
                (result as PromiseLike<unknown>).then(undefined, report);
            }
        } catch (error) {
            report(error);
        }
    };
    const { onLifecycle } = lifecycle;
    if (onLifecycle) {
        invoke("onLifecycle", () => onLifecycle.call(lifecycle, event));
    }
    switch (event.type) {
        case "connected":
            if (lifecycle.onConnected) {
                invoke("onConnected", () => lifecycle.onConnected?.());
            }
            break;
        case "disconnected":
            if (lifecycle.onDisconnected) {
                invoke("onDisconnected", () => lifecycle.onDisconnected?.(event.error));
            }
            break;
        case "reconnecting":
            if (lifecycle.onReconnecting) {
                invoke("onReconnecting", () => lifecycle.onReconnecting?.({ attempt: event.attempt, delay: event.delay, error: event.error }));
            }
            break;
        case "reconnect-failed":
            if (lifecycle.onReconnectFailed) {
                invoke("onReconnectFailed", () => lifecycle.onReconnectFailed?.(event.error));
            }
            break;
        case "setup-failed":
            if (lifecycle.onSetupFailed) {
                invoke("onSetupFailed", () => lifecycle.onSetupFailed?.(event.error, { initial: event.initial, attempt: event.attempt }));
            }
            break;
        default:
            // blocked / unblocked / settlement-skipped / consumer-lost / consumer-restored / consumer-restore-failed / lifecycle-error: union-only observability.
            break;
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
 * attached (before it without an initial connect budget, after it with one;
 * pinned by the exactly-once integration tests).
 *
 * With an initial connect budget the wiring is attached before amqplib's
 * first attempt, so the failures of the initial window arrive here too; see
 * {@link RecoveryLifecycleHooks.isInitialWindow} for how they differ from
 * reconnect failures.
 */
export function wireRecoveryLifecycle(conn: AmqpRecoveryEmitter, lifecycle: AmqpLifecycleCallbacks | undefined, hooks: RecoveryLifecycleHooks): void {
    conn.on("connect", () => {
        hooks.resetReconnectAttempt();
        hooks.deliverConnected();
    });
    conn.on("disconnect", (err: Error) => {
        hooks.noteConnectionError(err);
        hooks.failPendingReturns();
        dispatchLifecycle(lifecycle, { type: "disconnected", error: err });
    });
    conn.on("reconnect-scheduled", (info: { attempt: number; delay: number; error: Error }) => {
        if (hooks.isInitialWindow() && hooks.isClosing()) {
            return;
        }
        dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: info.attempt, delay: info.delay, error: info.error });
    });
    conn.on("connect-failed", (err: Error) => {
        hooks.noteConnectionError(err);
        if (hooks.isInitialWindow()) {
            // amqplib finishes an attempt that was already in flight when
            // the wrapper was closed and still reports its failure — often
            // one the adapter's own teardown caused (a channel closed under
            // a running setup). After disconnect() it must stay silent.
            if (hooks.isClosing()) {
                return;
            }
            hooks.clearPublishChannel();
            const attempt = hooks.nextInitialAttempt();
            if (err instanceof AmqpTopologyError) {
                dispatchLifecycle(lifecycle, { type: "setup-failed", initial: true, attempt, error: err });
            }
            if (hooks.initialFailFastGate(err)) {
                hooks.stopInitialConnect(err);
            }
            return;
        }
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
        // Tear down before notifying, like the fatal path: a callback that
        // reacts to the give-up (for example by calling connect() again) must
        // already see the dead cycle forgotten, not "already connected".
        hooks.markCycleDead();
        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: hooks.mapGiveUpError(err) });
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
/** Channel surface a delivery needs to be settled. */
interface DeliveryChannel {
    ack(message: amqp.Message): void;
    nack(message: amqp.Message, allUpTo: boolean, requeue: boolean): void;
}

/**
 * Settle a delivery, treating a closed channel as a no-op.
 *
 * Once a channel is closed amqplib's `ack`/`nack` throw `IllegalOperationError`.
 * That is not a failure: the broker requeues every delivery that was not
 * acknowledged before the channel closed, so the message comes back on its own.
 * Throwing would turn a handler that outlives its connection into an
 * unhandled rejection (the requeue after a rejected handler runs in a `.catch`
 * with nobody above it). The skipped settlement is reported as a
 * `settlement-skipped` lifecycle event. Any other error is not ours to hide.
 */
function settleDelivery(
    lifecycle: AmqpLifecycleCallbacks | undefined,
    delivery: { readonly queue: string; readonly message: amqp.ConsumeMessage },
    action: AmqpSettlementAction,
    settle: () => void,
): void {
    try {
        settle();
    } catch (error) {
        if (!(error instanceof Error) || error.name !== "IllegalOperationError") {
            throw error;
        }
        dispatchLifecycle(lifecycle, {
            type: "settlement-skipped",
            action,
            queue: delivery.queue,
            routingKey: delivery.message.fields.routingKey,
            deliveryTag: delivery.message.fields.deliveryTag,
            error,
        });
    }
}

/**
 * Turn one consumed AMQP message into a `RawEvent`, hand it to the handler and
 * settle it. Exported (not via the package barrel) for direct cross-runtime
 * unit testing with a channel double.
 *
 * - An undecodable payload is rejected without requeue (DLX or drop): it will
 *   never succeed.
 * - A rejected handler requeues the message for redelivery.
 * - A handler that throws synchronously (or returns a non-promise) is treated
 *   like a rejection: a throw that escaped the consume callback would make
 *   amqplib close the channel with 541 and silence the subscription.
 * - Every settlement tolerates a closed channel — see {@link settleDelivery}.
 */
export function handleDelivery(params: {
    readonly channel: DeliveryChannel;
    readonly message: amqp.ConsumeMessage;
    readonly queue: string;
    readonly handler: RawEventHandler;
    readonly decode: ((data: Uint8Array) => Uint8Array) | undefined;
    readonly lifecycle: AmqpLifecycleCallbacks | undefined;
}): void {
    const { channel, message: msg, queue, handler, decode, lifecycle } = params;
    const delivery = { queue, message: msg };

    // A second settlement of the same delivery tag makes the broker close the
    // channel (`precondition_failed: unknown delivery tag`), which silently
    // stops the consumer. The first settlement wins; later ones are no-ops.
    let settled = false;
    const settleOnce = (action: AmqpSettlementAction, settle: () => void): void => {
        if (settled) {
            return;
        }
        settleDelivery(lifecycle, delivery, action, settle);
        settled = true;
    };

    // The adapter's own settlements (reject of an undecodable payload, requeue
    // after a failed handler) have no caller to throw to: a failure other than a
    // closed channel is reported instead of escaping the consume callback.
    const reportSettlementFailure = (action: AmqpSettlementAction, error: unknown): void => {
        dispatchLifecycle(lifecycle, {
            type: "settlement-skipped",
            action,
            queue,
            routingKey: msg.fields.routingKey,
            deliveryTag: msg.fields.deliveryTag,
            error: error instanceof Error ? error : new Error(String(error), { cause: error }),
        });
    };

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
        try {
            settleOnce("reject", () => channel.nack(msg, false, false));
        } catch (error) {
            reportSettlementFailure("reject", error);
        }
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
        settleOnce("ack", () => channel.ack(msg));
    };
    const nack = async (requeue?: boolean): Promise<void> => {
        if (requeue === false) {
            // Reject without requeue — goes to DLX or is discarded
            settleOnce("reject", () => channel.nack(msg, false, false));
        } else {
            settleOnce("requeue", () => channel.nack(msg, false, true));
        }
    };

    // The handler runs inside a promise executor so a synchronous throw is a
    // rejection like any other: amqplib's channel has no `handler-error`
    // listener, so a throw escaping this callback closes the channel with 541
    // and the subscription silently stops consuming.
    new Promise<void>((resolve) => {
        resolve(handler(rawEvent, ack, nack));
    }).catch(() => {
        // Handler error — requeue for redelivery unless the handler already
        // settled the delivery (its explicit choice stands). Nothing may escape
        // from here: there is no caller above this callback, so a throw would be
        // an unhandled rejection. Any settlement failure is reported instead.
        try {
            settleOnce("requeue", () => channel.nack(msg, false, true));
        } catch (error) {
            reportSettlementFailure("requeue", error);
        }
    });
}

interface SubscriptionRecord extends RestorableSubscription {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
    readonly subOptions: RawSubscribeOptions | undefined;
    /** Channel of the CURRENT incarnation (replaced on recovery). */
    channel: amqp.Channel | null;
    isAutoGroup: boolean;
}

/** A timer handle the restorer can hold without keeping the process alive. */
export interface ConsumerTimer {
    unref(): unknown;
}

/** Timer primitives of the restorer; replaceable so tests can fire timers by hand. */
export interface ConsumerTimers {
    set(callback: () => void, delayMs: number): ConsumerTimer;
    clear(timer: ConsumerTimer): void;
}

const GLOBAL_TIMERS: ConsumerTimers = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/** Restoration bookkeeping of one subscription. */
export interface ConsumerRestoreState {
    /** Restore attempts since the last stable period; drives the backoff delay and is reported as `attempt`. */
    attempt: number;
    /** Pending backoff before the next attempt. */
    timer: ConsumerTimer | null;
    /** Zeroes `attempt` once a restored consumer has stayed up for the stability window. */
    stabilityTimer: ConsumerTimer | null;
    /** The consumer was lost while no live connection was known: restore once the connection is set up again. */
    pending: boolean;
}

/** One run of `startConsumer`: the state its channel listeners and consume callback share. */
export interface ConsumerIncarnation {
    /** The consumer is registered with the broker; before that a channel failure belongs to setup, not to a loss. */
    started: boolean;
    /**
     * A loss signalled before `started` was set: amqplib can deliver the
     * `consume` reply and the broker's cancel in one socket read, ahead of the
     * continuation that marks the consumer started. Replayed right after it.
     */
    earlyLoss: { readonly cause: AmqpConsumerLossCause; readonly error: Error | undefined } | null;
    /** The loss of this consumer was already handled (cancel, null delivery and close all signal one loss). */
    lost: boolean;
    /** The channel exception that closed the channel, when the broker sent one (carries the reply `code`). */
    channelError: Error | null;
}

/** The part of a subscription the restorer reads and writes. */
export interface RestorableSubscription {
    active: boolean;
    /** Number of the newest consumer incarnation; events of older ones are ignored. */
    generation: number;
    channel: { close(): Promise<unknown> } | null;
    consumerTag: string | null;
    queueName: string;
    /** Restoration of a consumer the broker ended on a live connection. */
    readonly restore: ConsumerRestoreState;
}

/** Minimal channel surface the loss detection listens to. */
export interface ConsumerChannelEvents {
    on(event: "error", listener: (err: Error) => void): unknown;
    on(event: "close" | "cancel", listener: () => void): unknown;
}

/**
 * Listen to a consumer channel for the ways the broker ends a consumer.
 *
 * A channel exception arrives as `error` (carrying the broker's numeric reply
 * code) and then `close`. A close with no preceding coded `error` is the
 * adapter closing its own channel, or a lost connection taking it down, and is
 * NOT a loss: connection recovery rebuilds those consumers. `cancel` is the
 * broker cancelling the consumer on an open channel (its queue was deleted).
 */
export function watchConsumerChannel(channel: ConsumerChannelEvents, incarnation: ConsumerIncarnation, onLost: (cause: AmqpConsumerLossCause, error?: Error) => void): void {
    channel.on("error", (err: Error) => {
        if (typeof (err as { code?: unknown }).code === "number") {
            incarnation.channelError = err;
        }
    });
    channel.on("close", () => {
        if (incarnation.channelError !== null) {
            onLost("channel-closed", incarnation.channelError);
        }
    });
    channel.on("cancel", () => {
        onLost("cancelled");
    });
}

/** What {@link createConsumerRestorer} needs from its adapter. */
export interface ConsumerRestorerDeps<R extends RestorableSubscription, M> {
    readonly lifecycle: AmqpLifecycleCallbacks | undefined;
    /** `false` reports a loss (`willRestore: false`) and leaves the subscription ended. */
    readonly enabled: boolean;
    readonly backoff: Pick<AmqpRecoveryOptions, "initialDelay" | "maxDelay" | "factor" | "jitter">;
    readonly isClosing: () => boolean;
    /** The connection a consumer may be restored on right now, or `null` while connection recovery owns it. */
    readonly liveModel: () => M | null;
    /** Start a consumer incarnation of the subscription on the connection. */
    readonly start: (model: M, record: R) => Promise<ConsumerIncarnation | null>;
    readonly timers?: ConsumerTimers;
    readonly random?: () => number;
}

/** One consumer loss, as the channel listeners and the consume callback report it. */
export interface ConsumerLoss<R extends RestorableSubscription> {
    readonly record: R;
    readonly generation: number;
    readonly incarnation: ConsumerIncarnation;
    readonly channel: { close(): Promise<unknown> };
    readonly queue: string;
    readonly cause: AmqpConsumerLossCause;
    readonly error?: Error | undefined;
}

export interface ConsumerRestorer<R extends RestorableSubscription> {
    /** The broker ended a consumer: report it once and schedule the restoration. */
    lost(loss: ConsumerLoss<R>): void;
    /** Forget the restoration of one subscription: no pending attempt, no stability timer, a fresh backoff series. */
    stop(record: R): void;
    /** The connection is live again: restore the consumers lost while it was not. */
    resume(records: Iterable<R>): void;
}

/**
 * The restoration of consumers the broker ended on a live connection.
 *
 * A loss is reported once (`consumer-lost`); with `enabled` the consumer is
 * started again after a backoff that grows with consecutive losses and
 * restarts only after a consumer has stayed up for the longest delay the
 * backoff can produce. A failure that cannot heal by retrying (the same
 * replies that stop connection recovery on topology drift) ends the
 * restoration; any other failure is retried. While `liveModel()` is `null`
 * connection recovery owns the connection: nothing is restarted here, and the
 * loss waits for `resume()`.
 */
export function createConsumerRestorer<R extends RestorableSubscription, M>(deps: ConsumerRestorerDeps<R, M>): ConsumerRestorer<R> {
    const timers = deps.timers ?? GLOBAL_TIMERS;
    const stabilityMs = effectiveRecoveryMaxDelay(deps.backoff);

    function stop(record: R): void {
        const state = record.restore;
        if (state.timer !== null) {
            timers.clear(state.timer);
            state.timer = null;
        }
        if (state.stabilityTimer !== null) {
            timers.clear(state.stabilityTimer);
            state.stabilityTimer = null;
        }
        state.attempt = 0;
        state.pending = false;
    }

    function schedule(record: R): void {
        const state = record.restore;
        if (!record.active || deps.isClosing()) {
            return;
        }
        if (deps.liveModel() === null) {
            state.pending = true;
            return;
        }
        if (state.timer !== null) {
            timers.clear(state.timer);
        }
        if (state.stabilityTimer !== null) {
            timers.clear(state.stabilityTimer);
            state.stabilityTimer = null;
        }
        state.attempt += 1;
        const attempt = state.attempt;
        state.timer = timers.set(
            () => {
                state.timer = null;
                void run(record, attempt);
            },
            computeRecoveryDelay(deps.backoff, attempt, deps.random),
        );
        state.timer.unref();
    }

    async function run(record: R, attempt: number): Promise<void> {
        const state = record.restore;
        if (!record.active || deps.isClosing()) {
            return;
        }
        const model = deps.liveModel();
        if (model === null) {
            state.pending = true;
            return;
        }

        let incarnation: ConsumerIncarnation | null;
        try {
            incarnation = await deps.start(model, record);
        } catch (err) {
            if (!record.active || deps.isClosing() || deps.liveModel() !== model || err instanceof AmqpConnectionError) {
                // The connection went down (or was replaced) under the attempt:
                // connection recovery rebuilds the consumer, not a retry of
                // this one. The connection is identified structurally, never by
                // error text: a pending broker call that dies with the
                // connection rejects with wording that varies and is wrapped
                // into a topology error by the caller.
                return;
            }
            const error = err instanceof Error ? err : new Error(String(err));
            const willRetry = !isDeterministicTopologyDrift(err);
            dispatchLifecycle(deps.lifecycle, { type: "consumer-restore-failed", queue: record.queueName, attempt, error, willRetry });
            if (willRetry) {
                schedule(record);
            }
            return;
        }
        if (incarnation === null || incarnation.lost) {
            // Superseded, unsubscribed, or lost again at once (that loss has
            // already scheduled the next attempt).
            return;
        }
        if (!record.active || deps.isClosing()) {
            // Unsubscribed or shut down while the attempt was returning.
            return;
        }
        dispatchLifecycle(deps.lifecycle, { type: "consumer-restored", queue: record.queueName, attempt });
        // A consumer that vanishes right after every restore must see growing
        // delays: the series restarts only after a full stability window.
        state.stabilityTimer = timers.set(() => {
            state.stabilityTimer = null;
            state.attempt = 0;
        }, stabilityMs);
        state.stabilityTimer.unref();
    }

    return {
        lost({ record, generation, incarnation, channel, queue, cause, error }: ConsumerLoss<R>): void {
            if (incarnation.lost || generation !== record.generation || !record.active || deps.isClosing()) {
                return;
            }
            if (!incarnation.started) {
                incarnation.earlyLoss ??= { cause, error };
                return;
            }
            incarnation.lost = true;
            if (record.channel === channel) {
                record.channel = null;
                record.consumerTag = null;
            }
            // After a cancel the channel is still open and would stay a
            // consumer-less channel holding its unacknowledged messages. Close
            // it: the broker returns those messages to the queue at once, so the
            // restored consumer receives them (a handler that never settles,
            // as under `consumer_timeout`, would otherwise keep them forever).
            // The price is a possible duplicate for a handler still running; a
            // late settlement fails locally and is reported as skipped.
            void channel.close().catch(() => undefined);

            dispatchLifecycle(deps.lifecycle, {
                type: "consumer-lost",
                queue,
                cause,
                ...(error === undefined ? {} : { error }),
                willRestore: deps.enabled,
            });
            if (deps.enabled) {
                schedule(record);
            }
        },
        stop,
        resume(records: Iterable<R>): void {
            for (const record of records) {
                if (record.restore.pending) {
                    record.restore.pending = false;
                    schedule(record);
                }
            }
        },
    };
}

/** Pending mandatory publish awaiting its confirm, keyed by publish id. */
interface PendingReturn {
    returned: boolean;
}

/** State of one recovering connection opened by one `connect()` call. */
interface RecoveryCycle {
    readonly wrapper: AmqpRecoveryEmitter & { close(): Promise<void> };
    /** See {@link RecoveryLifecycleHooks.isInitialWindow}. */
    initialWindow: boolean;
    /** Closed by disconnect() or by the startup fail-fast; its late events are ignored. */
    abandoned: boolean;
    /** Failed attempts of the initial window. */
    initialAttempts: number;
    /** The setup error that stopped the initial connect under fail-fast. */
    failFastError: Error | null;
    connectedDelivered: boolean;
    /** The guarded `recovery.backoff` of this cycle, or `null` without a hook. */
    readonly backoffGuard: BackoffGuard | null;
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
    rejectBackoffWithDelayKnobs(options.recovery);
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
    // Opt-in bounded publish retry (#195): null = disabled (bit-for-bit).
    const publishRetryRaw = options.publishRetry;
    const publishRetry =
        publishRetryRaw === undefined || publishRetryRaw === false
            ? null
            : (() => {
                  const o = publishRetryRaw === true ? {} : publishRetryRaw;
                  const rawBudget = o.maxRetries;
                  // Infinity is honored (retry until disconnect() aborts),
                  // mirroring recovery's maxRetries semantics.
                  const maxRetries =
                      rawBudget === Number.POSITIVE_INFINITY
                          ? Number.POSITIVE_INFINITY
                          : typeof rawBudget === "number" && Number.isFinite(rawBudget)
                            ? Math.max(0, Math.floor(rawBudget))
                            : 5;
                  return {
                      maxRetries,
                      backoff: { initialDelay: o.initialDelay ?? 100, maxDelay: o.maxDelay ?? 30_000, factor: o.factor ?? 2, jitter: o.jitter ?? 0.2 },
                      retryOnTimeout: o.retryOnTimeout === true,
                      onRetry: o.onRetry,
                  };
              })();
    const correlationHeader = externalContract ? false : (options.publisherOptions?.correlationHeader ?? true);
    const lifecycle = options.lifecycle;

    /** The recovering connection wrapper (amqplib opt-in recovery) or a plain connection. */
    let connection: amqp.ChannelModel | null = null;
    /**
     * A recovering connection still inside its bounded initial connect. It is
     * not `connection` yet — publish()/subscribe() must keep failing typed
     * "not connected" instead of parking on it — but disconnect() has to be
     * able to close it.
     */
    let pendingCycle: RecoveryCycle | null = null;
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
    // Root cause of a channel-level failure (e.g. 404 closing the channel on a
    // publish to a missing exchange). Confirm callbacks only see amqplib's
    // generic Error("channel closed") — this map preserves the broker reply
    // (with its code) for diagnosability and for the publish-retry gate.
    const publishChannelErrors = new WeakMap<amqp.ConfirmChannel, Error>();

    /** Pending mandatory publishes awaiting confirm (publish-id → return flag). */
    const pendingReturns = new Map<string, PendingReturn>();

    /** Single-flight chain for mandatory publishes when the header is disabled. */
    let mandatoryChain: Promise<unknown> = Promise.resolve();

    /** Replayable registry of subscriptions (source of truth across recoveries). */
    const subscriptionRecords: SubscriptionRecord[] = [];

    /**
     * The raw connection handed to the recovery setup hook, valid from the end
     * of that setup until the connection is lost again. Restoring a consumer
     * opens its channel on THIS object, never on the recovering wrapper: the
     * wrapper parks `createChannel` while the connection is down and would
     * resolve it after connection recovery has already rebuilt the consumer.
     */
    let liveModel: amqp.ChannelModel | null = null;
    const restorer = createConsumerRestorer<SubscriptionRecord, amqp.ChannelModel>({
        lifecycle,
        enabled: options.recovery !== false,
        backoff: typeof options.recovery === "object" ? options.recovery : {},
        isClosing: () => closing,
        liveModel: () => liveModel,
        start: (model, record) => startConsumer(model, record),
    });

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
     * Forget a recovery cycle that can never deliver a connection again —
     * either the adapter stopped it on deterministic topology drift, or
     * amqplib gave up after exhausting the retry budget.
     *
     * A dead wrapper left in `connection` would make `subscribe()` wait on
     * (or be rejected by) amqplib with an untyped error, make `publishRetry`
     * spend its whole budget, and make `connect()` refuse with "already
     * connected". Clearing it routes all three to their typed "not connected"
     * paths instead. The consumers died with the cycle, so their records are
     * dropped without network calls; keeping them would resurrect stale
     * subscriptions on the next `connect()`.
     */
    function markCycleDead(): void {
        connection = null;
        publishChannel = null;
        liveModel = null;
        for (const record of subscriptionRecords) {
            record.active = false;
            record.channel = null;
            record.consumerTag = null;
            restorer.stop(record);
        }
        subscriptionRecords.length = 0;
        failPendingReturns();
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

        ch.on("error", (err: Error) => {
            // Channel-level errors surface through the connection lifecycle
            // and through rejected confirm callbacks; the listener also
            // prevents unhandled 'error' crashes. Record the root cause (the
            // broker reply carries the code, e.g. 404) — the confirm callback
            // only ever sees a generic "channel closed".
            publishChannelErrors.set(ch, err);
        });

        publishChannel = ch;
    }

    /**
     * Start (or re-start after recovery or a consumer loss) a consumer for a
     * subscription record.
     *
     * Resolves with the new incarnation once it consumes, or `null` when a
     * newer incarnation took over or the subscription was dropped while this
     * one was being set up; in that case the channel is closed and an
     * auto-named queue this run already declared is deleted, because an
     * auto-delete queue that never had a consumer is not removed on its own.
     */
    async function startConsumer(model: amqp.ChannelModel, record: SubscriptionRecord): Promise<ConsumerIncarnation | null> {
        const group = record.subOptions?.group;
        const isAutoGroup = !group;
        const override: AmqpQueueOverride | undefined = group ? options.queueOverrides?.[group] : undefined;
        const mine = ++record.generation;
        const stillWanted = (): boolean => mine === record.generation && record.active && !closing;

        // Resolve queue name: explicit override → external contract queue;
        // named group → `${exchange}.${group}`; no group → exclusive auto queue.
        const queueName = override?.queue ?? (group ? `${exchange}.${group}` : `${exchange}.sub-${randomUUID()}`);
        const incarnation: ConsumerIncarnation = { started: false, earlyLoss: null, lost: false, channelError: null };

        let ch: amqp.Channel;
        try {
            ch = await model.createChannel();
        } catch (err) {
            // A subscribe() parked in the recovering wrapper's waiter queue is
            // rejected when the cycle dies: with amqplib's plain
            // Error("Connection closed") on a fatal topology stop or
            // disconnect, but with the last raw connection error
            // (ECONNRESET, ECONNREFUSED, ...) when amqplib gives up after the
            // retry budget. The text heuristic misses the latter; the adapter
            // has, however, already forgotten the cycle — amqplib emits
            // reconnect-failed synchronously, before this rejection is handled —
            // so a missing connection identifies it. Keep the documented
            // typed-error taxonomy at this public boundary.
            if (isConnectionLostError(err) || connection === null) {
                throw new AmqpConnectionError("Connection lost while establishing consumer channel", { cause: err });
            }
            throw err;
        }
        watchConsumerChannel(ch, incarnation, (cause, error) => {
            restorer.lost({ record, generation: mine, incarnation, channel: ch, queue: queueName, cause, error });
        });

        // Abandon this run: it is no longer the subscription's consumer.
        const abandon = async (declaredQueue: boolean): Promise<null> => {
            if (declaredQueue && isAutoGroup) {
                await ch.deleteQueue(queueName).catch(() => undefined);
            }
            await ch.close().catch(() => undefined);
            return null;
        };

        const prefetch = options.consumerOptions?.prefetch ?? DEFAULT_PREFETCH;
        await ch.prefetch(prefetch);
        if (!stillWanted()) {
            return abandon(false);
        }

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
        if (!stillWanted()) {
            return abandon(topologyMode === AmqpTopologyMode.ASSERT);
        }

        const decode = options.serialization?.decode;

        let consumeResult: amqp.Replies.Consume;
        try {
            consumeResult = await ch.consume(
                queueName,
                (msg: amqp.ConsumeMessage | null) => {
                    // A superseded incarnation hands nothing to the handler: its
                    // unacknowledged messages return to the queue when its channel closes.
                    if (mine !== record.generation) {
                        return;
                    }
                    if (!msg) {
                        // The broker cancelled the consumer (its queue was deleted,
                        // or the queue's node failed over).
                        restorer.lost({ record, generation: mine, incarnation, channel: ch, queue: queueName, cause: "cancelled" });
                        return;
                    }

                    handleDelivery({ channel: ch, message: msg, queue: queueName, handler: record.handler, decode, lifecycle });
                },
                { noAck: false },
            );
        } catch (err) {
            await ch.close().catch(() => undefined);
            throw topologyError(`Failed to consume from queue '${queueName}'`, err, { kind: "queue", name: queueName });
        }

        if (!stillWanted()) {
            return abandon(topologyMode === AmqpTopologyMode.ASSERT);
        }

        incarnation.started = true;
        record.channel = ch;
        record.consumerTag = consumeResult.consumerTag;
        record.queueName = queueName;
        record.isAutoGroup = isAutoGroup;
        if (incarnation.earlyLoss !== null) {
            restorer.lost({ record, generation: mine, incarnation, channel: ch, queue: queueName, ...incarnation.earlyLoss });
        }
        return incarnation;
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
                // This setup rebuilds the consumer: a restore in progress is superseded.
                restorer.stop(record);
                await startConsumer(model, record);
            }
        }
    }

    /**
     * Setup hook of the recovering connection: {@link onSetup}, then the
     * connection counts as live for consumer restoration. A consumer lost while
     * the setup was still running could not be restored then and is retried now.
     */
    async function onRecoverySetup(model: amqp.ChannelModel): Promise<void> {
        liveModel = null;
        await onSetup(model);
        liveModel = model;
        restorer.resume(subscriptionRecords);
    }

    function newRecoveryCycle(wrapper: RecoveryCycle["wrapper"], initialWindow: boolean, backoffGuard: BackoffGuard | null): RecoveryCycle {
        return { wrapper, initialWindow, abandoned: false, initialAttempts: 0, failFastError: null, connectedDelivered: false, backoffGuard };
    }

    /** Deliver `connected`: the first delivery of a cycle is the initial connect, later ones are recoveries. */
    function deliverCycleConnected(cycle: RecoveryCycle): void {
        const reconnected = cycle.connectedDelivered;
        cycle.connectedDelivered = true;
        dispatchLifecycle(lifecycle, { type: "connected", reconnected });
    }

    /** Attach the adapter's recovery lifecycle wiring to the cycle's recovering connection. */
    function wireRecoveryCycle(cycle: RecoveryCycle): void {
        const conn = cycle.wrapper;
        // A lost connection is reported SOLELY via the wrapper's
        // `disconnect` event (see wireRecoveryLifecycle) — mapping the
        // re-emitted raw `error` too double-fired `disconnected` on a
        // socket-level cut (fixed in 1.3.0). The no-op listener must
        // stay: an unhandled EventEmitter `error` crashes the process.
        conn.on("error", () => undefined);
        // From the loss on, a consumer cannot be restored on this connection:
        // the next setup hook rebuilds every consumer.
        conn.on("disconnect", () => {
            liveModel = null;
        });

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
            // In the initial window connect() delivers the first `connected`
            // itself, once the connection is usable.
            deliverConnected: () => {
                if (!cycle.initialWindow) {
                    deliverCycleConnected(cycle);
                }
            },
            fatalTopologyGate: (err) => options.treatTopologyErrorAsFatal === true && isDeterministicTopologyDrift(err),
            enterFatalState: () => {
                // Wrapper close() sets its stopped flag synchronously
                // (before the first await in RecoveringCore.close), so
                // amqplib's _scheduleReconnect — called right after
                // this handler — schedules nothing.
                void conn.close().catch(() => undefined);
                markCycleDead();
            },
            markCycleDead,
            isClosing: () => closing || cycle.abandoned,
            isInitialWindow: () => cycle.initialWindow,
            nextInitialAttempt: () => {
                cycle.initialAttempts += 1;
                return cycle.initialAttempts - 1;
            },
            // The same gate as the startup probe: any setup error of the
            // initial connect stops it when fail-fast is on.
            initialFailFastGate: (err) => options.failFastOnInitialSetupError === true && err instanceof AmqpTopologyError,
            stopInitialConnect: (err) => {
                cycle.failFastError = err;
                cycle.abandoned = true;
                // Synchronous stop, as in enterFatalState: no retry is scheduled.
                void conn.close().catch(() => undefined);
            },
            noteConnectionError: (err) => {
                cycle.backoffGuard?.noteConnectionError(err);
            },
            mapGiveUpError: (err) => cycle.backoffGuard?.giveUpError() ?? err,
        });
    }

    /**
     * Turn the rejection of amqplib's initial connect into the adapter's
     * error. amqplib rejects with plain `Error("Connection closed")` after
     * any close(), with the hook's error when the backoff hook failed, and
     * with the raw last error on exhaustion, so the cause is read from what
     * the adapter recorded, in this order: the startup fail-fast, then a
     * disconnect(), then a failed backoff hook, then an exhausted budget.
     */
    function initialConnectFailure(cycle: RecoveryCycle, err: unknown, budget: number): Error {
        if (cycle.failFastError !== null) {
            return cycle.failFastError;
        }
        if (closing || cycle.abandoned) {
            return new AmqpConnectionError("Adapter closed during the initial connect phase", { cause: err });
        }
        const hookFailure = cycle.backoffGuard?.giveUpError();
        if (hookFailure) {
            return hookFailure;
        }
        return new AmqpConnectionError(`Initial connect failed after ${cycle.initialAttempts} attempt(s) (initialConnectMaxRetries: ${budget})`, { cause: err });
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

            // A finite initialConnectMaxRetries bounds the initial connect
            // independently of steady-state recovery. amqplib runs that
            // bounded loop itself (initialMaxRetries), on the same recovering
            // connection that is kept after the first success.
            const initialBudget = normalizeInitialConnectBudget(recoveryOpts.initialConnectMaxRetries);

            // A fresh guard per connect(): a hook failure ends only the cycle it happened in.
            const backoffGuard = recoveryEnabled && recoveryOpts.backoff !== undefined ? createBackoffGuard(recoveryOpts.backoff) : null;

            const connectOptions = buildConnectOptions(options.socketOptions, clientProperties);
            if (recoveryEnabled) {
                // amqplib opt-in recovery: reconnect with backoff+jitter; our
                // setup hook re-creates channels/topology/subscriptions.
                connectOptions.recovery = buildRecoveryConnectOptions({
                    recovery: recoveryOpts,
                    setup: onRecoverySetup,
                    initialBudget,
                    calculateDelay: backoffGuard?.calculateDelay,
                });
            }

            // Optional fail-fast / observability probe: validate topology against
            // a throwaway NON-recovering connection BEFORE entering amqplib's
            // recovery loop, which never rejects connect() under the default
            // maxRetries=Infinity (so a permanent topology error would otherwise
            // hang connect() forever, silently). Runs only when opted in. A broker
            // that is merely unreachable here is transient (fall through to
            // recovery); only a deterministic AmqpTopologyError fails fast.
            // Skipped with an initial connect budget: the lifecycle wiring is
            // then attached before amqplib's first attempt, and every attempt
            // runs the full setup and reports its own failure.
            if (recoveryEnabled && initialBudget === null && (options.failFastOnInitialSetupError || lifecycle?.onSetupFailed || lifecycle?.onLifecycle)) {
                const probeOptions = buildConnectOptions(options.socketOptions, clientProperties);

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

            if (recoveryEnabled && initialBudget !== null) {
                // waitForConnect: false — amqplib returns the recovering
                // connection at once and defers its first attempt to a later
                // turn of the event loop, so the wiring below is in place
                // before any attempt of the initial window is reported.
                const wrapper = (await amqplib.connect(options.url, connectOptions)) as unknown as amqp.RecoveringChannelModel;
                if (closing) {
                    await wrapper.close().catch(() => undefined);
                    throw new AmqpConnectionError("Adapter closed while connect() was in progress");
                }
                const cycle = newRecoveryCycle(wrapper, true, backoffGuard);
                pendingCycle = cycle;
                wireRecoveryCycle(cycle);
                try {
                    await wrapper.waitForConnect();
                } catch (err) {
                    throw initialConnectFailure(cycle, err, initialBudget);
                } finally {
                    if (pendingCycle === cycle) {
                        pendingCycle = null;
                    }
                }
                // A disconnect() that landed after the first success but
                // before this point closed nothing the caller can see yet.
                if (closing || cycle.abandoned) {
                    await wrapper.close().catch(() => undefined);
                    throw new AmqpConnectionError("Adapter closed during the initial connect phase");
                }
                // The connection is handed over only now, and the initial
                // `connected` is delivered only after that: a listener that
                // subscribes from it must find the adapter connected.
                cycle.initialWindow = false;
                connection = wrapper as unknown as amqp.ChannelModel;
                deliverCycleConnected(cycle);
                return;
            }

            let conn: amqp.ChannelModel;
            try {
                conn = (await amqplib.connect(options.url, connectOptions)) as amqp.ChannelModel;
            } catch (err) {
                // With recovery, a rejection here means amqplib's initial loop
                // gave up (finite maxRetries without initialConnectMaxRetries):
                // it rejects with its raw last error (ECONNREFUSED, ...). Keep
                // the typed taxonomy at this public boundary, with the original
                // error as the cause; the adapter's own typed errors (e.g. a
                // topology error from setup) pass through unchanged. Without
                // recovery the raw error is left as is: that single-shot mode
                // has always surfaced it, and callers may match on its code.
                // A failed backoff hook also rejects here, with the hook's
                // error; it is reported as the hook failure it is, and the
                // last connection error stays unknown — this window is not
                // observable before amqplib resolves.
                const hookFailure = backoffGuard?.giveUpError();
                if (hookFailure) {
                    throw hookFailure;
                }
                if (recoveryEnabled && !(err instanceof AmqpTopologyError) && !(err instanceof AmqpConnectionError)) {
                    throw new AmqpConnectionError(`Initial connect failed: recovery gave up (maxRetries: ${String(recoveryOpts.maxRetries)})`, { cause: err });
                }
                throw err;
            }

            // Re-check after the await: a disconnect() that landed while THIS
            // connect was in flight saw connection === null and closed nothing —
            // proceeding here would wire and leak an orphaned live connection
            // (and dispatch `connected` after the caller tore the adapter down).
            if (closing) {
                await conn.close().catch(() => undefined);
                throw new AmqpConnectionError("Adapter closed while connect() was in progress");
            }

            if (recoveryEnabled) {
                // Without an initial connect budget amqplib resolved only after
                // the first success, so the wiring attaches after the initial
                // window: its per-retry events stay unreported.
                const cycle = newRecoveryCycle(conn, false, backoffGuard);
                wireRecoveryCycle(cycle);

                // With recovery, the wrapper already ran onSetup before resolving.
                connection = conn;
                // Exactly-once `connected`, ordering-independent: amqplib
                // emits the initial `connect` before connect() resolves —
                // before the wiring attached — so it is delivered here; were
                // it emitted after the wiring attached, the wrapper listener
                // would have delivered it and this is skipped.
                if (!cycle.connectedDelivered) {
                    deliverCycleConnected(cycle);
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
            conn.on("close", (closeCause?: unknown) => {
                connection = null;
                publishChannel = null;
                failPendingReturns();
                // Not a "loss" when the adapter itself is closing (disconnect())
                // or discarding a connection whose setup failed (the caller
                // gets the thrown error instead).
                if (!closing && !setupFailedClose) {
                    dispatchLifecycle(lifecycle, {
                        type: "disconnected",
                        error: resolveDisconnectCause(lastConnError, closeCause),
                    });
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
            liveModel = null;

            // A connect() still inside its initial window owns a live
            // recovering connection that is not `connection` yet. Close it
            // first: that cancels a pending retry at once and makes connect()
            // reject, and nothing below can tear down state under an attempt
            // that is still running its setup.
            if (pendingCycle) {
                const cycle = pendingCycle;
                pendingCycle = null;
                cycle.abandoned = true;
                await cycle.wrapper.close().catch(() => undefined);
            }

            // Unsubscribe all active subscriptions first (with error isolation).
            for (const record of subscriptionRecords) {
                restorer.stop(record);
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
            // With retry disabled the entry guard is the historical fail-fast;
            // with retry enabled a disconnected window is a RETRIABLE state
            // (the whole point of #195), so the guard moves into each attempt.
            const chAtEntry = publishChannel;
            if (publishRetry === null && (!chAtEntry || closing)) {
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
            // The correlation id is PER ATTEMPT under publishRetry: a late
            // basic.return from an abandoned (timed-out) attempt must never
            // poison the next attempt's pending record. It is private wire
            // correlation — the dedup identity (x-event-id / messageId) stays
            // stable across attempts.
            let attemptSerial = 0;
            const nextPublishId = (): string | null => {
                if (!mandatory) {
                    return null;
                }
                attemptSerial += 1;
                return attemptSerial === 1 ? eventId : `${eventId}#${attemptSerial}`;
            };

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

            const doPublish = async (ch: amqp.ConfirmChannel): Promise<void> => {
                const publishId = nextPublishId();
                if (publishId !== null && correlationHeader) {
                    // Restamped per attempt (publishProps.headers references
                    // this object; amqplib serializes at publish time).
                    headers[PUBLISH_ID_HEADER] = publishId;
                }
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
                                        // A channel-level root cause (broker reply with its
                                        // code, e.g. 404) replaces amqplib's generic
                                        // "channel closed" for diagnosability and the
                                        // publish-retry determinism gate.
                                        reject(
                                            classifyConfirmError({
                                                err: (closedPublishChannels.has(ch) ? publishChannelErrors.get(ch) : undefined) ?? err,
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
                            const rootCause = publishChannelErrors.get(ch) ?? err;
                            settle(() => reject(new AmqpConnectionError(`Publish failed: ${err instanceof Error ? err.message : String(err)}`, { cause: rootCause })));
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

            // Bounded retry loop (#195): strictly for the auto-retry boundary
            // (isAutoRetriablePublishError), aborting on closing. eventId /
            // messageId / timestamp were resolved ONCE above, so every attempt
            // re-sends the identical message (consumer-side dedup anchor);
            // only the private return-correlation id differs per attempt.
            const runPublish = async (): Promise<void> => {
                if (publishRetry === null) {
                    // Bit-for-bit legacy path: single attempt on the channel
                    // captured at entry, no re-checks at slot-execution time
                    // (a queued single-flight publish that starts during a
                    // disconnect() race is attempted, exactly as before).
                    return doPublish(chAtEntry as amqp.ConfirmChannel);
                }
                for (let attempt = 0; ; attempt += 1) {
                    let attemptChannel: amqp.ConfirmChannel | null = null;
                    try {
                        // Re-resolve the CURRENT channel per attempt (recovery
                        // may have swapped it between retries).
                        attemptChannel = publishChannel;
                        if (!attemptChannel || closing) {
                            throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
                        }
                        return await doPublish(attemptChannel);
                    } catch (err) {
                        if (closing || attempt >= publishRetry.maxRetries || !isAutoRetriablePublishError(err, publishRetry)) {
                            throw err;
                        }
                        if (isBrokerClosedCurrentChannel(attemptChannel, publishChannel, publishChannelErrors)) {
                            throw err;
                        }
                        // No connection object at all (fatal topology stop,
                        // recovery gave up, post-disconnect, never connected):
                        // no recovery cycle exists to heal us — burn no budget.
                        if (connection === null) {
                            throw err;
                        }
                        const delay = computeRecoveryDelay(publishRetry.backoff, attempt + 1);
                        try {
                            publishRetry.onRetry?.({ attempt: attempt + 1, delay, error: err instanceof Error ? err : new Error(String(err)), routingKey });
                        } catch {
                            // Observability hooks must not break the retry loop.
                        }
                        // Interruptible backoff — disconnect()/drain must not
                        // park behind a long delay (contract with #196).
                        for (let waited = 0; waited < delay && !closing; waited += 100) {
                            await new Promise<void>((resolve) => {
                                globalThis.setTimeout(resolve, Math.min(100, delay - waited));
                            });
                        }
                        if (closing) {
                            throw err;
                        }
                    }
                }
            };

            // Confirms are always per-message: every publish resolves on its
            // own broker ack (or rejects with a typed error).
            if (mandatory && !correlationHeader) {
                // Single-flight: serialize mandatory publishes so the headerless
                // return frame is unambiguously the outstanding one. The WHOLE
                // retry loop runs inside the slot (hold-the-chain): ordering is
                // preserved at the cost of head-of-line blocking during backoff.
                const run = mandatoryChain.then(runPublish, runPublish);
                mandatoryChain = run.catch(() => undefined);
                return run;
            }

            return runPublish();
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
                generation: 0,
                restore: { attempt: 0, timer: null, stabilityTimer: null, pending: false },
            };

            const cycle = connection;
            const incarnation = await startConsumer(cycle, record);
            // The cycle may have died while the consumer was being set up
            // (recovery gave up, fatal stop, disconnect). The dead-cycle
            // bookkeeping has then already cleared the subscription list, so
            // recording this subscription now would make a later connect()
            // replay it on a fresh cycle. Drop it and report the loss instead.
            if (connection !== cycle || incarnation === null) {
                const orphan = record.channel;
                record.active = false;
                record.channel = null;
                record.consumerTag = null;
                await orphan?.close().catch(() => undefined);
                throw new AmqpConnectionError("Connection lost while establishing consumer channel");
            }
            subscriptionRecords.push(record);

            const subscription: EventSubscription = {
                async unsubscribe(): Promise<void> {
                    record.active = false;
                    restorer.stop(record);

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
