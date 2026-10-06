/**
 * `drainTimeout` must hold even when the adapter's `unsubscribe()` itself
 * waits for the in-flight handler.
 *
 * Redis (`await loopPromise`), Kafka (`consumer.disconnect()` waits for the
 * running `eachBatch`) and NATS (the iterator drains its current body) all
 * behave this way: `unsubscribe()` resolves only after the handler returns.
 * If `stop()` awaited `unsubscribe()` BEFORE starting the drain, the documented
 * force-abort after `drainTimeout` could never fire early — the only limit left
 * would be the per-event `handlerTimeout`.
 *
 * The adapter here reproduces exactly that blocking behaviour without a broker,
 * so the bus-level contract is pinned in the unit suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.BlockingUnsubscribeService", methods: [fakeMethod] } as any;

function rawEvent(id: string): RawEvent {
    return {
        eventId: id,
        eventType: EventOptionsSchema.typeName,
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

interface Harness {
    readonly order: string[];
    readonly bus: ReturnType<typeof createEventBus>;
    deliver(id: string): Promise<void>;
    abortReason(): unknown;
    handlerFinished(): boolean;
}

/**
 * Builds a bus whose adapter blocks `unsubscribe()` until every delivered
 * handler call has returned, and whose handler runs `handlerBody`.
 */
function makeHarness(options: { drainTimeout: number; handlerTimeout: number }, handlerBody: (signal: AbortSignal) => Promise<void>): Harness {
    const order: string[] = [];
    let wrapped: RawEventHandler | null = null;
    const delivered = new Set<Promise<void>>();
    let reason: unknown;
    let finished = false;

    const adapter: EventAdapter = {
        name: "blocking-unsubscribe",
        connect: async () => undefined,
        disconnect: async () => {
            order.push("disconnect");
        },
        publish: async () => undefined,
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            wrapped = handler;
            return {
                unsubscribe: async () => {
                    await Promise.allSettled([...delivered]);
                    order.push("unsubscribed");
                },
            };
        },
    };

    const bus = createEventBus({
        adapter,
        drainTimeout: options.drainTimeout,
        handlerTimeout: options.handlerTimeout,
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async (_msg: unknown, ctx: { signal: AbortSignal }) => {
                        try {
                            await handlerBody(ctx.signal);
                        } finally {
                            reason = ctx.signal.aborted ? ctx.signal.reason : undefined;
                            finished = true;
                        }
                    },
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
    });

    return {
        order,
        bus,
        deliver: (id) => {
            assert.ok(wrapped, "subscribe must have captured the wrapped handler");
            const call = (wrapped as RawEventHandler)(
                rawEvent(id),
                async () => undefined,
                async () => undefined,
            );
            delivered.add(call);
            return call;
        },
        abortReason: () => reason,
        handlerFinished: () => finished,
    };
}

/** Resolves once the signal aborts (a handler that cooperates with cancellation). */
function untilAborted(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("stop() with an adapter whose unsubscribe waits for the in-flight handler", () => {
    it("force-aborts the handler at drainTimeout, not at handlerTimeout", async () => {
        const harness = makeHarness({ drainTimeout: 150, handlerTimeout: 4_000 }, untilAborted);
        await harness.bus.start();

        const handlerDone = harness.deliver("evt-hung");
        await sleep(20);

        const startedAt = Date.now();
        await harness.bus.stop();
        const took = Date.now() - startedAt;
        await handlerDone;

        assert.equal(harness.abortReason(), "Drain timeout exceeded", "the drain must be the reason the handler was cancelled");
        assert.ok(took >= 130, `stop() must still give the handler its drain window (took ${took}ms)`);
        assert.ok(took < 1_500, `stop() must be bounded by drainTimeout, not by handlerTimeout (took ${took}ms)`);
        assert.deepEqual(harness.order, ["unsubscribed", "disconnect"], "the adapter disconnects only after the subscription is closed");
    });

    it("lets a handler that finishes inside the drain window complete without aborting it", async () => {
        const harness = makeHarness({ drainTimeout: 2_000, handlerTimeout: 4_000 }, () => sleep(60));
        await harness.bus.start();

        const handlerDone = harness.deliver("evt-quick");
        await sleep(10);

        const startedAt = Date.now();
        await harness.bus.stop();
        const took = Date.now() - startedAt;
        await handlerDone;

        assert.ok(harness.handlerFinished(), "the handler must have run to completion");
        assert.equal(harness.abortReason(), undefined, "a handler that finishes in time must not be aborted");
        assert.ok(took < 1_000, `stop() must return as soon as the handler is done (took ${took}ms)`);
        assert.deepEqual(harness.order, ["unsubscribed", "disconnect"]);
    });

    it("aborts immediately when drainTimeout is 0", async () => {
        const harness = makeHarness({ drainTimeout: 0, handlerTimeout: 4_000 }, untilAborted);
        await harness.bus.start();

        const handlerDone = harness.deliver("evt-no-drain");
        await sleep(20);

        const startedAt = Date.now();
        await harness.bus.stop();
        const took = Date.now() - startedAt;
        await handlerDone;

        assert.equal(harness.abortReason(), "Drain timeout exceeded");
        assert.ok(took < 1_000, `a zero drain window must not wait for the handler (took ${took}ms)`);
    });

    it("stop() with no handler in flight does not wait for the drain window", async () => {
        const harness = makeHarness({ drainTimeout: 5_000, handlerTimeout: 4_000 }, untilAborted);
        await harness.bus.start();

        const startedAt = Date.now();
        await harness.bus.stop();
        const took = Date.now() - startedAt;

        assert.ok(took < 500, `an idle bus must stop at once (took ${took}ms)`);
        assert.deepEqual(harness.order, ["unsubscribed", "disconnect"]);
    });
});
