/**
 * The shutdown signal ends reception.
 *
 * Under `createServer` the server aborts its signal first and the bus is stopped by a hook some
 * time later. A delivery that arrives in between must not start a handler whose `ctx.signal` is
 * already aborted (the retry middleware does not retry after a cancellation, a transient failure
 * would be dead-lettered): the bus ends its subscriptions at the abort and returns anything that
 * still arrives to the broker. Handlers that are running keep going, and `stop()` still drains
 * them and disconnects. A fake adapter counts `unsubscribe()` calls and hands the wrapped handler
 * to the test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventContext, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.AbortReceptionService", methods: [fakeMethod] } as any;

const rawEvent: RawEvent = {
    eventId: "evt-after-abort",
    eventType: EventOptionsSchema.typeName,
    payload: new Uint8Array(),
    publishedAt: new Date(),
    attempt: 1,
    metadata: new Map(),
};

function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Rig {
    readonly bus: ReturnType<typeof createEventBus>;
    readonly handled: string[];
    readonly acks: string[];
    readonly nacks: Array<boolean | undefined>;
    readonly published: string[];
    unsubscribeCalls(): number;
    disconnectCalls(): number;
    deliver(): Promise<void>;
}

type Body = (ctx: EventContext) => Promise<void>;

/** `holdSubscribe` delays the end of `adapter.subscribe()` so a test can abort while `start()` is still subscribing. */
function makeRig(body: Body, options: { signal?: AbortSignal; holdSubscribe?: Promise<void> } = {}): Rig {
    let captured: RawEventHandler | null = null;
    let unsubscribes = 0;
    let disconnects = 0;
    const handled: string[] = [];
    const acks: string[] = [];
    const nacks: Array<boolean | undefined> = [];
    const published: string[] = [];
    const adapter: EventAdapter = {
        name: "abort-reception",
        connect: async () => undefined,
        disconnect: async () => {
            disconnects++;
        },
        publish: async (topic) => {
            published.push(topic);
        },
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            await options.holdSubscribe;
            captured = handler;
            return {
                unsubscribe: async () => {
                    unsubscribes++;
                },
            };
        },
    };
    const bus = createEventBus({
        adapter,
        drainTimeout: 500,
        ...(options.signal ? { signal: options.signal } : {}),
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async (_message: unknown, ctx: EventContext) => {
                        handled.push(rawEvent.eventId);
                        await body(ctx);
                    },
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
    });
    return {
        bus,
        handled,
        acks,
        nacks,
        published,
        unsubscribeCalls: () => unsubscribes,
        disconnectCalls: () => disconnects,
        deliver: () => {
            assert.ok(captured, "subscribe must have captured the wrapped handler");
            return (captured as RawEventHandler)(
                rawEvent,
                async () => {
                    acks.push("ack");
                },
                async (requeue) => {
                    nacks.push(requeue);
                },
            );
        },
    };
}

describe("the shutdown signal ends reception", () => {
    it("returns a delivery that arrives after the abort to the broker and runs no handler", async () => {
        const controller = new AbortController();
        const rig = makeRig(async () => undefined);
        await rig.bus.start({ signal: controller.signal });

        controller.abort();
        await rig.deliver();

        assert.deepEqual(rig.handled, [], "no handler may start after the abort");
        assert.deepEqual(rig.nacks, [true], "the delivery goes back to the broker with a requeue");
        assert.deepEqual(rig.acks, [], "it must not be acknowledged");
        assert.equal(rig.unsubscribeCalls(), 1, "reception ends at the abort, before stop() runs");
        assert.equal(rig.disconnectCalls(), 0, "the adapter stays connected until stop()");

        await rig.bus.stop();
    });

    it("ends the subscriptions once when stop() runs after the abort", async () => {
        const controller = new AbortController();
        const rig = makeRig(async () => undefined);
        await rig.bus.start({ signal: controller.signal });

        controller.abort();
        await sleep(0);
        await rig.bus.stop();

        assert.equal(rig.unsubscribeCalls(), 1);
        assert.equal(rig.disconnectCalls(), 1);
    });

    it("ends the subscriptions once when the signal aborts while stop() is running", async () => {
        const controller = new AbortController();
        const hold = gate();
        const rig = makeRig(async () => hold.wait);
        await rig.bus.start({ signal: controller.signal });

        const delivery = rig.deliver();
        await sleep(10);
        const stopping = rig.bus.stop();
        controller.abort();
        hold.release();
        await delivery;
        await stopping;

        assert.equal(rig.unsubscribeCalls(), 1);
        assert.equal(rig.disconnectCalls(), 1);
    });

    it("lets a running handler finish and relay through ctx.publish after the abort", async () => {
        const controller = new AbortController();
        const hold = gate();
        const rig = makeRig(async (ctx) => {
            await hold.wait;
            await ctx.publish(EventOptionsSchema, create(EventOptionsSchema, {}), { topic: "relayed.after.abort" });
        });
        await rig.bus.start({ signal: controller.signal });

        const delivery = rig.deliver();
        await sleep(10);
        controller.abort();
        assert.equal(rig.unsubscribeCalls(), 1);
        hold.release();
        await delivery;
        await rig.bus.stop();

        assert.deepEqual(rig.handled, ["evt-after-abort"], "the handler that was running is not cancelled by the gate");
        assert.deepEqual(rig.published, ["relayed.after.abort"], "its publish still reaches the adapter");
        assert.deepEqual(rig.acks, ["ack"], "it is acknowledged as usual");
        assert.deepEqual(rig.nacks, []);
        assert.equal(rig.disconnectCalls(), 1);
    });

    it("ends the subscriptions as soon as start() has made them when the signal aborts while start() is subscribing", async () => {
        const controller = new AbortController();
        const hold = gate();
        const rig = makeRig(async () => undefined, { holdSubscribe: hold.wait });

        const starting = rig.bus.start({ signal: controller.signal });
        await sleep(10);
        controller.abort();
        hold.release();
        await starting;
        await sleep(0);

        assert.equal(rig.unsubscribeCalls(), 1);
        await rig.deliver();
        assert.deepEqual(rig.handled, []);
        assert.deepEqual(rig.nacks, [true]);

        await rig.bus.stop();
        assert.equal(rig.unsubscribeCalls(), 1, "stop() does not end them a second time");
    });

    it("handles no delivery when it is started with a signal that is already aborted", async () => {
        const rig = makeRig(async () => undefined);
        await rig.bus.start({ signal: AbortSignal.abort() });
        await sleep(0);

        assert.equal(rig.unsubscribeCalls(), 1);
        await rig.deliver();
        assert.deepEqual(rig.handled, []);
        assert.deepEqual(rig.nacks, [true]);

        await rig.bus.stop();
        assert.equal(rig.unsubscribeCalls(), 1);
    });

    it("applies the signal given as the bus option the same way", async () => {
        const controller = new AbortController();
        const rig = makeRig(async () => undefined, { signal: controller.signal });
        await rig.bus.start();

        controller.abort();
        await rig.deliver();

        assert.deepEqual(rig.handled, []);
        assert.deepEqual(rig.nacks, [true]);
        assert.equal(rig.unsubscribeCalls(), 1);
        await rig.bus.stop();
    });

    it("stays started after the abort until stop() releases it, and ends the next cycle by its own signal", async () => {
        const first = new AbortController();
        const rig = makeRig(async () => undefined);
        await rig.bus.start({ signal: first.signal });

        first.abort();
        await sleep(0);
        assert.equal(rig.disconnectCalls(), 0, "the abort alone does not disconnect");
        await rig.bus.stop();
        assert.equal(rig.unsubscribeCalls(), 1);

        const second = new AbortController();
        await rig.bus.start({ signal: second.signal });
        await rig.deliver();
        assert.deepEqual(rig.handled, ["evt-after-abort"], "a fresh cycle with a live signal handles deliveries");

        second.abort();
        await sleep(0);
        assert.equal(rig.unsubscribeCalls(), 2, "the new signal ends the new cycle's subscriptions");
        await rig.bus.stop();
        assert.equal(rig.unsubscribeCalls(), 2);
    });

    it("does not let the signal of an earlier cycle end the next cycle", async () => {
        const first = new AbortController();
        const rig = makeRig(async () => undefined);
        await rig.bus.start({ signal: first.signal });
        await rig.bus.stop();
        assert.equal(rig.unsubscribeCalls(), 1);

        const second = new AbortController();
        await rig.bus.start({ signal: second.signal });
        // The first signal is still live when the second cycle runs: only a listener left behind by the first cycle could react to it.
        first.abort();
        await sleep(0);
        assert.equal(rig.unsubscribeCalls(), 1, "the earlier signal no longer reaches the bus");
        await rig.deliver();
        assert.deepEqual(rig.handled, ["evt-after-abort"], "the next cycle still receives");
        await rig.bus.stop();
    });
});
