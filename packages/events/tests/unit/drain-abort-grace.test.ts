/**
 * `drainAbortGrace` and the shutdown observer.
 *
 * After `drainTimeout` the bus aborts the handlers that are still running and, without
 * `drainAbortGrace`, waits for them without limit. With it, a handler that ignores the abort is
 * abandoned when the grace ends: `stop()` returns, the observer is told, and the adapter is
 * disconnected. Uses a fake adapter that hands the wrapped handler to the test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventBusObserverEvent, EventBusOptions, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.GraceService", methods: [fakeMethod] } as any;

const rawEvent: RawEvent = {
    eventId: "evt-grace",
    eventType: EventOptionsSchema.typeName,
    payload: new Uint8Array(),
    publishedAt: new Date(),
    attempt: 1,
    metadata: new Map(),
};

/** A bus whose handler runs `body`; the raw handler is captured so the test can deliver an event. */
function makeBus(body: (ctx: { signal: AbortSignal }) => Promise<void>, extra: Partial<EventBusOptions>, options: { closeWaitsForDisconnect?: boolean } = {}) {
    let captured: RawEventHandler | null = null;
    const disconnects: number[] = [];
    // Like the Redis, Kafka and NATS adapters: closing the subscription finishes only when the
    // running handler returns. Here the stuck handler never returns, so only the disconnect ends it.
    let closed: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
        closed = resolve;
    });
    const adapter: EventAdapter = {
        name: "grace",
        connect: async () => undefined,
        disconnect: async () => {
            disconnects.push(Date.now());
            closed();
        },
        publish: () => new Promise<void>(() => undefined),
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            captured = handler;
            return { unsubscribe: async () => (options.closeWaitsForDisconnect === true ? closing : undefined) };
        },
    };
    const bus = createEventBus({
        adapter,
        drainTimeout: 100,
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async (_msg: unknown, ctx: { signal: AbortSignal }) => body(ctx),
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
        ...extra,
    });
    const deliver = (): Promise<void> => (captured as unknown as RawEventHandler)(rawEvent, async () => undefined, async () => undefined);
    return { bus, deliver, disconnects };
}

/** Never returns: ignores the abort signal, as a handler stuck in a call without cancellation does. */
const stuck = (): Promise<void> => new Promise<void>(() => undefined);

describe("drainAbortGrace", () => {
    it("abandons a handler that ignores the abort when the grace ends, reports it, and disconnects", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver, disconnects } = makeBus(stuck, { drainAbortGrace: 150, observer: (event) => void events.push(event) });
        await bus.start();
        void deliver();
        await sleep(10);

        const startedAt = Date.now();
        await bus.stop();
        const took = Date.now() - startedAt;

        assert.ok(took >= 230, `stop() must wait drainTimeout + drainAbortGrace (took ${took}ms)`);
        assert.ok(took < 1_000, `stop() must not wait for a handler that never returns (took ${took}ms)`);
        assert.equal(disconnects.length, 1, "the adapter is disconnected once");
        assert.deepEqual(events, [{ type: "abandoned", handlers: 1, publishes: 0 }]);
    });

    it("does not wait for an adapter that closes the subscription only when the stuck handler returns", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver, disconnects } = makeBus(stuck, { drainAbortGrace: 100, observer: (event) => void events.push(event) }, { closeWaitsForDisconnect: true });
        await bus.start();
        void deliver();
        await sleep(10);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
            bus.stop().then(() => "stopped" as const),
            new Promise<"hung">((resolve) => {
                timer = setTimeout(() => resolve("hung"), 3_000);
            }),
        ]);
        clearTimeout(timer);

        assert.equal(outcome, "stopped", "stop() must go on to disconnect instead of waiting for the subscription close of a stuck handler");
        assert.equal(disconnects.length, 1);
        assert.deepEqual(events, [{ type: "abandoned", handlers: 1, publishes: 0 }]);
    });

    it("drainAbortGrace 0 abandons at once after the abort", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver } = makeBus(stuck, { drainAbortGrace: 0, observer: (event) => void events.push(event) });
        await bus.start();
        void deliver();
        await sleep(10);

        const startedAt = Date.now();
        await bus.stop();
        const took = Date.now() - startedAt;

        assert.ok(took < 400, `grace 0 must not wait after the abort (took ${took}ms)`);
        assert.deepEqual(events, [{ type: "abandoned", handlers: 1, publishes: 0 }]);
    });

    it("a handler that returns within the grace is not abandoned", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver } = makeBus(
            async (ctx) => {
                await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => setTimeout(resolve, 50), { once: true }));
            },
            { drainAbortGrace: 2_000, observer: (event) => void events.push(event) },
        );
        await bus.start();
        const handled = deliver();
        await sleep(10);

        await bus.stop();
        await handled;

        assert.deepEqual(events, [], "nothing was left, so nothing is reported");
    });

    it("a restart after a drain abort gives handlers a signal that is not aborted", async () => {
        // The drain abort ends cycle one. A bus that kept its aborted controller across stop()/start()
        // would hand cycle two a signal that is aborted before the handler runs.
        let cycle = 0;
        const seenAborted: boolean[] = [];
        const { bus, deliver } = makeBus(
            async (ctx) => {
                cycle++;
                if (cycle === 1) {
                    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
                    return;
                }
                seenAborted.push(ctx.signal.aborted);
            },
            { drainAbortGrace: 2_000 },
        );
        await bus.start();
        const first = deliver();
        await sleep(10);
        await bus.stop();
        await first;
        assert.equal(cycle, 1);

        await bus.start();
        await deliver();
        await bus.stop();

        assert.deepEqual(seenAborted, [false], "the handler of the second cycle must see a live signal");
    });

    it("without drainAbortGrace the wait after the abort has no limit (a slow handler is waited for)", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver } = makeBus(
            async (ctx) => {
                await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => setTimeout(resolve, 400), { once: true }));
            },
            { observer: (event) => void events.push(event) },
        );
        await bus.start();
        const handled = deliver();
        await sleep(10);

        const startedAt = Date.now();
        await bus.stop();
        const took = Date.now() - startedAt;
        await handled;

        assert.ok(took >= 480, `the slow handler must be waited for (took ${took}ms)`);
        assert.deepEqual(events, []);
    });

    it("reports a publish that is still unsettled when drainPublishTimeout ends", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus } = makeBus(async () => undefined, { drainPublishTimeout: 80, observer: (event) => void events.push(event) });
        await bus.start();
        void bus.publish(EventOptionsSchema, create(EventOptionsSchema, {})).catch(() => undefined);
        await sleep(10);

        await bus.stop();

        assert.deepEqual(events, [{ type: "abandoned", handlers: 0, publishes: 1 }]);
    });

    it("still reports a handler abandoned at its own deadline when it settles while the publish drain goes on", async () => {
        const events: EventBusObserverEvent[] = [];
        const { bus, deliver } = makeBus(() => sleep(250), { drainTimeout: 30, drainAbortGrace: 0, drainPublishTimeout: 600, observer: (event) => void events.push(event) });
        await bus.start();
        void deliver();
        void bus.publish(EventOptionsSchema, create(EventOptionsSchema, {})).catch(() => undefined);
        await sleep(10);

        await bus.stop();

        assert.deepEqual(events, [{ type: "abandoned", handlers: 1, publishes: 1 }], "the handler was given up on at its deadline although it returned later");
    });

    it("an observer that throws does not stop the shutdown", async () => {
        const { bus, deliver, disconnects } = makeBus(stuck, {
            drainAbortGrace: 0,
            observer: () => {
                throw new Error("observer failed");
            },
        });
        await bus.start();
        void deliver();
        await sleep(10);

        await bus.stop();

        assert.equal(disconnects.length, 1);
    });

    it("an observer whose promise rejects does not raise an unhandled rejection", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            const { bus, deliver, disconnects } = makeBus(stuck, { drainAbortGrace: 0, observer: async () => Promise.reject(new Error("observer rejected")) });
            await bus.start();
            void deliver();
            await sleep(10);

            await bus.stop();
            await sleep(20);

            assert.equal(disconnects.length, 1);
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects ${String(bad)} at creation`, () => {
            assert.throws(() => makeBus(stuck, { drainAbortGrace: bad }), RangeError);
        });
    }
});
