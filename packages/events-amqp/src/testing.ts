/**
 * Programmable AMQP test double — the `@connectum/events-amqp/testing` subpath (#203).
 *
 * `FakeAmqpAdapter` models the REAL adapter's observable contracts without a
 * broker and without importing `amqplib` at runtime:
 *
 * - the typed error taxonomy (`AmqpConnectionError`, `AmqpTopologyError`, …) —
 *   inject outcomes per publish via {@link FakeAmqpControl.nextPublish},
 *   including `AmqpPublishTimeoutError`: the state-UNKNOWN outcome that no
 *   real broker (or even Toxiproxy) reproduces deterministically;
 * - the canonical lifecycle union ({@link AmqpLifecycleCallbacks.onLifecycle})
 *   INCLUDING the deprecated flat-callback shim — events go through the real
 *   adapter's dispatch, so ordering, shim payloads, and exception isolation
 *   match the real adapter by construction;
 * - the state machine: `connect()` on a live or recovering (or dead
 *   retries-exhausted) adapter throws `already connected` like the real one;
 *   a mid-recovery `subscribe()` PARKS and settles with the recovery outcome;
 *   the probe-then-recover `connect()` semantics gate on `AmqpTopologyError`
 *   exactly like the real probe.
 *
 * Deliberately NOT modeled (documented divergences):
 * - timing: there is no backoff — recovery advances only via explicit
 *   {@link FakeAmqpControl.completeRecovery} / {@link FakeAmqpControl.exhaustRecovery}
 *   calls, and `reconnecting.delay` is always `0`;
 * - a queued topology `failSetup` at `connect()` WITHOUT fail-fast reports
 *   `setup-failed { initial: true }` and then connects anyway (the real
 *   adapter would keep retrying inside recovery); a NON-topology queued
 *   failure at `connect()` is consumed silently and the connect proceeds
 *   (the real adapter treats it as transient and blocks in recovery);
 * - broker-driven settlement: handler `ack`/`nack` calls are RECORDED (see
 *   the {@link FakeAmqpControl.deliver} result) but do not drive redelivery —
 *   re-deliver explicitly with a higher `attempt` to model it. Handler
 *   rejections are swallowed exactly like the real consumer (which nacks for
 *   redelivery instead of propagating);
 * - the wire-level envelope: {@link FakeAmqpControl.published} records the
 *   bus-facing call as the adapter received it. Wire fidelity is the real
 *   adapter's integration-tested domain. Incoming envelope headers ARE
 *   handled with parity: `deliver()` honors `x-event-id`/`x-published-at`
 *   and strips the internal keys from handler-visible metadata.
 *
 * @module testing
 */

import { randomUUID } from "node:crypto";
import type { AdapterContext, EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler, RawSubscribeOptions } from "@connectum/events";
import { matchPattern } from "@connectum/events";
import { dispatchLifecycle } from "./AmqpAdapter.ts";
import type { AmqpTopologyObject } from "./errors.ts";
import { AmqpConnectionError, AmqpTopologyError } from "./errors.ts";
import type { AmqpLifecycleCallbacks } from "./types.ts";

/** Options for {@link FakeAmqpAdapter}. */
export interface FakeAmqpAdapterOptions {
    /** The same lifecycle surface as the real adapter (union + flat shim). */
    readonly lifecycle?: AmqpLifecycleCallbacks;
    /**
     * Mirror of the real option: a topology `failSetup(...)` queued before
     * `connect()` rejects it with the typed error instead of report-and-proceed.
     */
    readonly failFastOnInitialSetupError?: boolean;
}

/** One publish outcome: `"ack"` resolves; an `Error` rejects the publish with it. */
export type FakePublishOutcome = "ack" | Error;

/** A recorded successful publish, as the adapter received it from the bus. */
export interface FakePublishedRecord {
    readonly eventType: string;
    readonly payload: Uint8Array;
    readonly options?: PublishOptions;
}

/** Settlement summary of one {@link FakeAmqpControl.deliver} call. */
export interface FakeDeliveryResult {
    /** Handlers invoked (one per matching fan-out sub + one per distinct group). */
    readonly delivered: number;
    /** Handlers that called `ack()`. */
    readonly acked: number;
    /** Handlers that called `nack(false)`. */
    readonly nacked: number;
    /** Handlers that called `nack(true)` — model redelivery by delivering again with `attempt + 1`. */
    readonly requeued: number;
    /** Handlers that rejected (swallowed, like the real consumer's nack-on-error path). */
    readonly failed: number;
}

/** Deterministic control surface of the fake. */
export interface FakeAmqpControl {
    /**
     * Queue a setup failure. An `AmqpTopologyError` (the default) follows the
     * real gating: `setup-failed { initial: true, attempt: 0 }` at `connect()`
     * (typed rejection under `failFastOnInitialSetupError`), or
     * `setup-failed { initial: false, attempt }` at the next
     * {@link completeRecovery}. A NON-topology error follows the real gating
     * too: no `setup-failed` event — at `connect()` it is consumed silently,
     * at `completeRecovery` it only schedules the next `reconnecting`.
     */
    failSetup(error?: Error, object?: AmqpTopologyObject): void;
    /**
     * Sever the connection: dispatches `disconnected { error }` then
     * `reconnecting { attempt: 1, delay: 0 }` and parks in the recovering
     * state — publishes fail fast with `AmqpConnectionError`, exactly like
     * the real adapter's recovery window; new `subscribe()` calls PARK.
     */
    dropConnection(error?: Error): void;
    /**
     * Advance a pending recovery: consumes a queued `failSetup` (reported per
     * its gating, stays recovering) or, with nothing queued, completes with
     * `connected { reconnected: true }` and settles parked subscribes.
     */
    completeRecovery(): void;
    /**
     * Terminal outcome: `reconnect-failed { error }`. The dead adapter fails
     * publishes fast, rejects parked subscribes typed, and deactivates all
     * subscriptions (the cycle died — so did its consumers). Reconnect
     * requires `disconnect()` first, like the real retries-exhausted state.
     */
    exhaustRecovery(error?: Error): void;
    /** Broker flow control: `blocked { reason }` / `unblocked` (union-only events). */
    block(reason?: string): void;
    unblock(): void;
    /**
     * Queue FIFO outcomes for upcoming `publish()` calls. An empty queue means
     * `"ack"`. Use the real error classes (`AmqpPublishNackError`,
     * `AmqpConnectionError`, `AmqpPublishTimeoutError` — the state-UNKNOWN
     * outcome only this fake reproduces deterministically, …).
     */
    nextPublish(...outcomes: FakePublishOutcome[]): void;
    /** Successfully acked publishes, in order. */
    readonly published: readonly FakePublishedRecord[];
    /**
     * Deliver an event to matching subscriptions (NATS-style wildcard
     * matching, one consumer per distinct group — competing-consumer parity;
     * requires the connected state, like a real broker). Internal envelope
     * keys (`x-event-id`, `x-published-at`, `x-connectum-publish-id`) are
     * honored and stripped from handler-visible metadata, mirroring the real
     * consumer. Resolves with the settlement summary once every handler
     * settles; handler rejections are swallowed (counted in `failed`).
     */
    deliver(eventType: string, payload: Uint8Array, options?: { readonly metadata?: Record<string, string>; readonly attempt?: number }): Promise<FakeDeliveryResult>;
}

/** The fake adapter: a drop-in {@link EventAdapter} plus its {@link FakeAmqpControl}. */
export interface FakeAmqpAdapterInstance extends EventAdapter {
    readonly control: FakeAmqpControl;
}

const CONNECTION_STATE = {
    CREATED: "created",
    CONNECTED: "connected",
    RECOVERING: "recovering",
    DEAD: "dead",
    CLOSED: "closed",
} as const;
type ConnectionState = (typeof CONNECTION_STATE)[keyof typeof CONNECTION_STATE];

const INTERNAL_HEADERS = ["x-event-id", "x-published-at", "x-connectum-publish-id"] as const;

interface FakeSubscription {
    readonly patterns: string[];
    readonly handler: RawEventHandler;
    readonly group: string | null;
    active: boolean;
}

interface ParkedSubscribe {
    readonly register: () => EventSubscription;
    readonly resolve: (sub: EventSubscription) => void;
    readonly reject: (err: Error) => void;
}

/**
 * Create a programmable AMQP adapter test double.
 *
 * @example
 * ```typescript
 * import { FakeAmqpAdapter } from '@connectum/events-amqp/testing';
 * import { AmqpPublishTimeoutError } from '@connectum/events-amqp';
 *
 * const fake = FakeAmqpAdapter();
 * const bus = createEventBus({ adapter: fake, routes: [eventRoutes] });
 * await bus.start();
 *
 * // The state-UNKNOWN outcome, untestable against a real broker:
 * fake.control.nextPublish(new AmqpPublishTimeoutError('no outcome (UNKNOWN)'));
 * await assert.rejects(() => bus.publish(OrderSchema, order), AmqpPublishTimeoutError);
 *
 * fake.control.dropConnection();          // disconnected → reconnecting
 * fake.control.completeRecovery();        // connected { reconnected: true }
 * ```
 */
export function FakeAmqpAdapter(options: FakeAmqpAdapterOptions = {}): FakeAmqpAdapterInstance {
    const lifecycle = options.lifecycle;

    let state: ConnectionState = CONNECTION_STATE.CREATED;
    let reassertAttempt = 0;
    const pendingSetupFailures: Array<{ error: Error }> = [];
    const publishOutcomes: FakePublishOutcome[] = [];
    const published: FakePublishedRecord[] = [];
    const subscriptions: FakeSubscription[] = [];
    const parkedSubscribes: ParkedSubscribe[] = [];

    const queuedSetupFailure = (): { error: Error } | undefined => pendingSetupFailures.shift();

    const registerSubscription = (patterns: string[], handler: RawEventHandler, group: string | null): EventSubscription => {
        const sub: FakeSubscription = { patterns, handler, group, active: true };
        subscriptions.push(sub);
        return {
            async unsubscribe(): Promise<void> {
                sub.active = false;
            },
        };
    };

    const control: FakeAmqpControl = {
        failSetup(error?: Error, object?: AmqpTopologyObject): void {
            const err =
                error ??
                new AmqpTopologyError(
                    "Topology check failed (missing broker object): NOT_FOUND",
                    object !== undefined
                        ? { cause: Object.assign(new Error("NOT_FOUND"), { code: 404 }), object }
                        : { cause: Object.assign(new Error("NOT_FOUND"), { code: 404 }) },
                );
            pendingSetupFailures.push({ error: err });
        },

        dropConnection(error?: Error): void {
            if (state !== CONNECTION_STATE.CONNECTED) {
                throw new Error(`FakeAmqpAdapter.control.dropConnection(): adapter is '${state}', not 'connected'`);
            }
            const err = error ?? new Error("Connection closed: 320 (connection-forced)");
            state = CONNECTION_STATE.RECOVERING;
            reassertAttempt = 0;
            dispatchLifecycle(lifecycle, { type: "disconnected", error: err });
            reassertAttempt += 1;
            dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: reassertAttempt, delay: 0, error: err });
        },

        completeRecovery(): void {
            if (state !== CONNECTION_STATE.RECOVERING) {
                throw new Error(`FakeAmqpAdapter.control.completeRecovery(): adapter is '${state}', not 'recovering'`);
            }
            const failure = queuedSetupFailure();
            if (failure) {
                // Re-assert failed: mirrors connect-failed (+ reconnect-scheduled)
                // of the real recovery. The setup-failed event is gated on
                // AmqpTopologyError exactly like the real wiring; delay is 0
                // (the fake does not model backoff).
                if (failure.error instanceof AmqpTopologyError) {
                    dispatchLifecycle(lifecycle, { type: "setup-failed", initial: false, attempt: reassertAttempt, error: failure.error });
                }
                reassertAttempt += 1;
                dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: reassertAttempt, delay: 0, error: failure.error });
                return;
            }
            state = CONNECTION_STATE.CONNECTED;
            dispatchLifecycle(lifecycle, { type: "connected", reconnected: true });
            // Parked mid-recovery subscribes complete with the recovery, like
            // the real adapter's waiter queue.
            for (const parked of parkedSubscribes.splice(0)) {
                parked.resolve(parked.register());
            }
        },

        exhaustRecovery(error?: Error): void {
            if (state !== CONNECTION_STATE.RECOVERING) {
                throw new Error(`FakeAmqpAdapter.control.exhaustRecovery(): adapter is '${state}', not 'recovering'`);
            }
            state = CONNECTION_STATE.DEAD;
            dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: error ?? new Error("recovery exhausted") });
            // The cycle died — so did its consumers and any parked subscribes
            // (same typed error the real startConsumer remaps to).
            for (const sub of subscriptions) {
                sub.active = false;
            }
            for (const parked of parkedSubscribes.splice(0)) {
                parked.reject(new AmqpConnectionError("Connection lost while establishing consumer channel", { cause: error }));
            }
        },

        block(reason = "memory alarm"): void {
            dispatchLifecycle(lifecycle, { type: "blocked", reason });
        },

        unblock(): void {
            dispatchLifecycle(lifecycle, { type: "unblocked" });
        },

        nextPublish(...outcomes: FakePublishOutcome[]): void {
            publishOutcomes.push(...outcomes);
        },

        get published(): readonly FakePublishedRecord[] {
            return published;
        },

        async deliver(
            eventType: string,
            payload: Uint8Array,
            deliverOptions?: { readonly metadata?: Record<string, string>; readonly attempt?: number },
        ): Promise<FakeDeliveryResult> {
            if (state !== CONNECTION_STATE.CONNECTED) {
                // A real broker cannot deliver during a drop window or after a
                // terminal reconnect-failed.
                throw new Error(`FakeAmqpAdapter.control.deliver(): adapter is '${state}', not 'connected'`);
            }
            const rawMetadata = new Map<string, string>(Object.entries(deliverOptions?.metadata ?? {}));
            const eventId = rawMetadata.get("x-event-id") ?? randomUUID();
            const publishedAtHeader = rawMetadata.get("x-published-at");
            const publishedAt = publishedAtHeader !== undefined ? new Date(publishedAtHeader) : new Date();
            // The real consumer strips the internal envelope from
            // handler-visible metadata.
            for (const key of INTERNAL_HEADERS) {
                rawMetadata.delete(key);
            }
            const event: RawEvent = {
                eventId,
                eventType,
                payload,
                publishedAt,
                attempt: deliverOptions?.attempt ?? 1,
                metadata: rawMetadata,
            };

            // Competing-consumer parity: one delivery per DISTINCT group, plus
            // every group-less (fan-out) subscription.
            const seenGroups = new Set<string>();
            const targets: FakeSubscription[] = [];
            for (const sub of subscriptions) {
                if (!sub.active || !sub.patterns.some((pattern) => matchPattern(pattern, eventType))) {
                    continue;
                }
                if (sub.group === null) {
                    targets.push(sub);
                } else if (!seenGroups.has(sub.group)) {
                    seenGroups.add(sub.group);
                    targets.push(sub);
                }
            }

            let acked = 0;
            let nacked = 0;
            let requeued = 0;
            let failed = 0;
            // allSettled + swallowed rejections: the real consumer catches a
            // throwing handler and nacks for redelivery instead of propagating.
            const settlements = await Promise.allSettled(
                targets.map((sub) =>
                    sub.handler(
                        event,
                        async () => {
                            acked += 1;
                        },
                        async (requeue?: boolean) => {
                            if (requeue) {
                                requeued += 1;
                            } else {
                                nacked += 1;
                            }
                        },
                    ),
                ),
            );
            for (const settlement of settlements) {
                if (settlement.status === "rejected") {
                    failed += 1;
                }
            }
            return { delivered: targets.length, acked, nacked, requeued, failed };
        },
    };

    const adapter: FakeAmqpAdapterInstance = {
        name: "fake-amqp",
        control,

        async connect(_context?: AdapterContext): Promise<void> {
            if (state === CONNECTION_STATE.CONNECTED || state === CONNECTION_STATE.RECOVERING || state === CONNECTION_STATE.DEAD) {
                // Parity: the real adapter keeps `connection` non-null through
                // the whole recovery window AND after a plain retries-exhausted
                // reconnect-failed — reconnecting requires disconnect() first.
                throw new AmqpConnectionError("AmqpAdapter: already connected");
            }
            const failure = queuedSetupFailure();
            if (failure) {
                if (failure.error instanceof AmqpTopologyError) {
                    // Probe semantics (#200): a DETERMINISTIC startup failure
                    // is observable and rejects typed under fail-fast.
                    dispatchLifecycle(lifecycle, { type: "setup-failed", initial: true, attempt: 0, error: failure.error });
                    if (options.failFastOnInitialSetupError) {
                        throw failure.error;
                    }
                }
                // Non-topology (transient) failure, or fail-fast off: the fake
                // proceeds (documented divergence — the real adapter would
                // block inside recovery).
            }
            state = CONNECTION_STATE.CONNECTED;
            reassertAttempt = 0;
            dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
        },

        async disconnect(): Promise<void> {
            // Own disconnect is not a "loss": no disconnected event (parity
            // with the real adapter). A fresh connect() afterwards works.
            state = CONNECTION_STATE.CLOSED;
            for (const sub of subscriptions) {
                sub.active = false;
            }
            subscriptions.length = 0;
            for (const parked of parkedSubscribes.splice(0)) {
                parked.reject(new AmqpConnectionError("Connection lost while establishing consumer channel"));
            }
        },

        async publish(eventType: string, payload: Uint8Array, publishOptions?: PublishOptions): Promise<void> {
            if (state !== CONNECTION_STATE.CONNECTED) {
                // Same message as the real adapter's fail-fast path.
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }
            const outcome = publishOutcomes.shift() ?? "ack";
            if (outcome !== "ack") {
                throw outcome;
            }
            published.push({ eventType, payload, ...(publishOptions !== undefined ? { options: publishOptions } : {}) });
        },

        async subscribe(patterns: string[], handler: RawEventHandler, subOptions?: RawSubscribeOptions): Promise<EventSubscription> {
            const group = subOptions?.group ?? null;
            if (state === CONNECTION_STATE.RECOVERING) {
                // Parity: the real adapter accepts a mid-recovery subscribe —
                // channel creation parks in the recovery wrapper's waiter
                // queue and settles with the recovery outcome.
                return new Promise<EventSubscription>((resolve, reject) => {
                    parkedSubscribes.push({
                        register: () => registerSubscription(patterns, handler, group),
                        resolve,
                        reject,
                    });
                });
            }
            if (state !== CONNECTION_STATE.CONNECTED) {
                throw new AmqpConnectionError("AmqpAdapter: not connected (or recovery in progress)");
            }
            return registerSubscription(patterns, handler, group);
        },
    };

    return adapter;
}
