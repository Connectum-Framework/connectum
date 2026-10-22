/**
 * `ctx.publish`: a handler that is still running when `stop()` begins hands its result on.
 *
 * `bus.publish` is refused while the bus stops; `ctx.publish` is admitted for the one delivery
 * whose handler has not returned, in the bus and the start/stop cycle it belongs to, until the
 * drain is aborted. `stop()` waits for what was admitted (and for the republish of the built-in
 * dead-letter middleware) before the adapter is disconnected. A fake adapter hands the wrapped
 * handler to the test and settles publishes only when told to.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { createEventContext } from "../../src/EventContext.ts";
import type { EventAdapter, EventBusObserverEvent, EventBusOptions, EventContext, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const msg = () => create(EventOptionsSchema, {});

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.RelayService", methods: [fakeMethod] } as any;

const rawEvent: RawEvent = {
    eventId: "evt-relay",
    eventType: EventOptionsSchema.typeName,
    payload: new Uint8Array(),
    publishedAt: new Date(),
    attempt: 1,
    metadata: new Map(),
};

interface PendingPublish {
    readonly topic: string;
    resolve(): void;
    reject(error: Error): void;
}

type Body = (ctx: EventContext) => Promise<void>;

function makeBus(body: Body, extra: Partial<EventBusOptions> = {}, options: { holdUnsubscribe?: Promise<void> } = {}) {
    let captured: RawEventHandler | null = null;
    const order: string[] = [];
    const publishes: PendingPublish[] = [];
    const events: EventBusObserverEvent[] = [];
    const adapter: EventAdapter = {
        name: "relay",
        connect: async () => undefined,
        disconnect: async () => {
            order.push("disconnect");
        },
        publish: (topic) =>
            new Promise<void>((resolve, reject) => {
                order.push(`publish:${topic}`);
                publishes.push({
                    topic,
                    resolve: () => {
                        order.push(`settled:${topic}`);
                        resolve();
                    },
                    reject,
                });
            }),
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            captured = handler;
            return { unsubscribe: async () => options.holdUnsubscribe };
        },
    };
    const bus = createEventBus({
        adapter,
        drainTimeout: 150,
        observer: (event) => void events.push(event),
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async (_message: unknown, ctx: EventContext) => body(ctx),
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
        ...extra,
    });
    const acks: string[] = [];
    const deliver = (): Promise<void> =>
        (captured as unknown as RawEventHandler)(
            rawEvent,
            async () => void acks.push("ack"),
            async (requeue) => void acks.push(requeue === false ? "reject" : "requeue"),
        );
    return { bus, deliver, order, publishes, events, acks };
}

describe("ctx.publish while the bus is running", () => {
    it("publishes like bus.publish", async () => {
        const { bus, deliver, publishes, order } = makeBus(async (ctx) => {
            await ctx.publish(EventOptionsSchema, msg(), { topic: "out.running" });
        });
        await bus.start();
        const handled = deliver();
        await sleep(10);
        publishes[0]?.resolve();
        await handled;

        assert.deepEqual(order, ["publish:out.running", "settled:out.running"]);
        await bus.stop();
    });

    it("a context built without a bus rejects", async () => {
        const ctx = createEventContext({ raw: rawEvent, signal: new AbortController().signal, onAck: async () => undefined, onNack: async () => undefined });
        await assert.rejects(() => ctx.publish(EventOptionsSchema, msg()), /ctx\.publish is unavailable/);
    });
});

describe("ctx.publish while the bus stops", () => {
    it("is admitted for a running handler, and stop() disconnects only after it settled", async () => {
        const { bus, deliver, publishes, order, events } = makeBus(async (ctx) => {
            await sleep(30); // stop() has begun when this publish is made
            await ctx.publish(EventOptionsSchema, msg(), { topic: "out.relay" });
        });
        await bus.start();
        const handled = deliver();
        await sleep(5);
        const stopping = bus.stop();
        await sleep(60);
        assert.deepEqual(order, ["publish:out.relay"], "the relay publish reached the adapter while stopping");
        publishes[0]?.resolve();
        await Promise.all([stopping, handled]);

        assert.deepEqual(order, ["publish:out.relay", "settled:out.relay", "disconnect"]);
        assert.deepEqual(events, [{ type: "admitted", topic: "out.relay" }]);
    });

    it("stop() also waits for an admitted publish that the handler did not await", async () => {
        const { bus, deliver, publishes, order } = makeBus(async (ctx) => {
            await sleep(30);
            void ctx.publish(EventOptionsSchema, msg(), { topic: "out.forgotten" }).catch(() => undefined);
        });
        await bus.start();
        const handled = deliver();
        await sleep(5);
        const stopping = bus.stop();
        await handled;
        await sleep(40);
        assert.deepEqual(order, ["publish:out.forgotten"], "stop() must still be holding the disconnect");
        publishes[0]?.resolve();
        await stopping;

        assert.deepEqual(order, ["publish:out.forgotten", "settled:out.forgotten", "disconnect"]);
    });

    it("bus.publish from outside a handler is still refused", async () => {
        const { bus, deliver } = makeBus(async () => sleep(60));
        await bus.start();
        const handled = deliver();
        await sleep(5);
        const stopping = bus.stop();

        await assert.rejects(() => bus.publish(EventOptionsSchema, msg(), { topic: "out.outside" }), /EventBus is stopping/);
        await Promise.all([stopping, handled]);
    });

    it("the right ends with the handler: a kept ctx.publish is refused afterwards", async () => {
        let kept: EventContext["publish"] | undefined;
        let release: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        // unsubscribe() holds stop() open after the handler has returned
        const { bus, deliver, events, order } = makeBus(
            async (ctx) => {
                kept = ctx.publish;
            },
            {},
            { holdUnsubscribe: hold },
        );
        await bus.start();
        await deliver();
        const stopping = bus.stop();
        await sleep(20);

        await assert.rejects(() => (kept as EventContext["publish"])(EventOptionsSchema, msg(), { topic: "out.late" }), /EventBus is stopping/);
        assert.deepEqual(events, [{ type: "rejected", reason: "not-in-flight" }]);
        assert.deepEqual(order, []);
        release();
        await stopping;
    });

    it("the right ends with the handler: a timer that fires after the handler returned is refused", async () => {
        let lateResult: Promise<void> | undefined;
        let release: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { bus, deliver, order } = makeBus(
            async (ctx) => {
                setTimeout(() => {
                    lateResult = ctx.publish(EventOptionsSchema, msg(), { topic: "out.timer" });
                    lateResult.catch(() => undefined);
                }, 40);
            },
            {},
            { holdUnsubscribe: hold },
        );
        await bus.start();
        await deliver();
        const stopping = bus.stop();
        await sleep(80);

        assert.ok(lateResult, "the timer must have fired");
        await assert.rejects(() => lateResult as Promise<void>, /EventBus is stopping/);
        assert.deepEqual(order, []);
        release();
        await stopping;
    });

    it("the right does not cross start/stop cycles", async () => {
        let kept: EventContext["publish"] | undefined;
        const { bus, deliver, order } = makeBus(async (ctx) => {
            kept = ctx.publish;
        });
        await bus.start();
        await deliver();
        await bus.stop();
        await bus.start();

        await assert.rejects(() => (kept as EventContext["publish"])(EventOptionsSchema, msg(), { topic: "out.cycle" }), /ctx\.publish was called after its handler returned or after the bus stopped/);
        assert.ok(!order.includes("publish:out.cycle"));
        await bus.stop();
    });

    it("an abandoned handler that wakes up after a new start has no right to publish", async () => {
        let wake: () => void = () => undefined;
        const asleep = new Promise<void>((resolve) => {
            wake = resolve;
        });
        let late: Promise<void> | undefined;
        // Ignores the abort, so it is still `alive` when the grace ends and the bus is started again.
        const { bus, deliver, order, events } = makeBus(
            async (ctx) => {
                await asleep;
                late = ctx.publish(EventOptionsSchema, msg(), { topic: "out.abandoned" });
                late.catch(() => undefined);
            },
            { drainAbortGrace: 0 },
        );
        await bus.start();
        const handled = deliver();
        await sleep(5);
        await bus.stop();
        await bus.start();
        wake();
        await handled;

        assert.ok(late, "the abandoned handler must have tried to publish");
        await assert.rejects(() => late as Promise<void>, /ctx\.publish was called after its handler returned or after the bus stopped/);
        assert.ok(!order.includes("publish:out.abandoned"), "nothing reached the adapter");
        assert.deepEqual(events, [{ type: "abandoned", handlers: 1, publishes: 0 }]);
        await bus.stop();
    });

    it("the publish of a context reaches only the adapter of its own bus", async () => {
        const other = makeBus(async () => undefined);
        const { bus } = makeBus(async () => undefined);
        let kept: EventContext["publish"] | undefined;
        const captured = makeBus(async (ctx) => {
            kept = ctx.publish;
        });
        await captured.bus.start();
        await captured.deliver();
        await bus.start();
        await other.bus.start();

        await captured.bus.stop();
        await assert.rejects(() => (kept as EventContext["publish"])(EventOptionsSchema, msg(), { topic: "out.bus" }));
        assert.deepEqual(other.order, []);
        assert.deepEqual(captured.order, ["disconnect"]);
        await bus.stop();
        await other.bus.stop();
    });

    it("is refused after the drain was aborted, and reports it", async () => {
        const { bus, deliver, events, order } = makeBus(async (ctx) => {
            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
            await ctx.publish(EventOptionsSchema, msg(), { topic: "out.aborted" });
        });
        await bus.start();
        const handled = deliver();
        await sleep(5);
        await bus.stop();
        await handled.catch(() => undefined);

        assert.deepEqual(events, [{ type: "rejected", reason: "aborted" }]);
        assert.ok(!order.includes("publish:out.aborted"));
    });

    it("a failed admitted publish reaches its handler and does not break stop()", async () => {
        let seen: unknown;
        const { bus, deliver, publishes, order } = makeBus(async (ctx) => {
            await sleep(30);
            try {
                await ctx.publish(EventOptionsSchema, msg(), { topic: "out.fail" });
            } catch (error) {
                seen = error;
            }
        });
        await bus.start();
        const handled = deliver();
        await sleep(5);
        const stopping = bus.stop();
        await sleep(60);
        publishes[0]?.reject(new Error("broker said no"));
        await Promise.all([stopping, handled]);

        assert.equal((seen as Error).message, "broker said no");
        assert.deepEqual(order.at(-1), "disconnect");
    });

    it("drainAbortGrace bounds the wait for an admitted publish that never settles, and reports it", async () => {
        const { bus, deliver, events, order } = makeBus(
            async (ctx) => {
                await sleep(20);
                void ctx.publish(EventOptionsSchema, msg(), { topic: "out.hang" }).catch(() => undefined);
            },
            { drainAbortGrace: 120 },
        );
        await bus.start();
        const handled = deliver();
        await sleep(5);

        const startedAt = Date.now();
        await bus.stop();
        await handled;

        assert.ok(Date.now() - startedAt < 1_500, "stop() must not wait for the hanging publish forever");
        assert.deepEqual(order.at(-1), "disconnect");
        assert.deepEqual(events, [{ type: "admitted", topic: "out.hang" }, { type: "abandoned", handlers: 0, publishes: 1 }]);
    });
});

describe("the dead-letter republish while the bus stops", () => {
    it("is awaited before disconnect and reported", async () => {
        const { bus, deliver, publishes, order, events } = makeBus(
            async () => {
                await sleep(30);
                throw new Error("handler failed");
            },
            { middleware: { dlq: { topic: "dead.letters" } } },
        );
        await bus.start();
        const handled = deliver();
        await sleep(5);
        const stopping = bus.stop();
        await sleep(60);

        assert.deepEqual(order, ["publish:dead.letters"], "the republish started while stopping");
        publishes[0]?.resolve();
        await Promise.all([stopping, handled]);

        assert.deepEqual(order, ["publish:dead.letters", "settled:dead.letters", "disconnect"]);
        assert.deepEqual(events, [{ type: "dlq-republish", topic: "dead.letters" }]);
    });

    it("counts as unfinished publish work when it never settles and the grace ends", async () => {
        const { bus, deliver, events } = makeBus(
            async () => {
                await sleep(30);
                throw new Error("handler failed");
            },
            { middleware: { dlq: { topic: "dead.letters" } }, drainAbortGrace: 100 },
        );
        await bus.start();
        void deliver();
        await sleep(5);

        await bus.stop();

        assert.deepEqual(events, [
            { type: "dlq-republish", topic: "dead.letters" },
            { type: "abandoned", handlers: 1, publishes: 1 },
        ]);
    });

    it("is not tracked or reported while the bus runs", async () => {
        const { bus, deliver, publishes, events } = makeBus(
            async () => {
                throw new Error("handler failed");
            },
            { middleware: { dlq: { topic: "dead.letters" } } },
        );
        await bus.start();
        const handled = deliver();
        await sleep(10);
        publishes[0]?.resolve();
        await handled;

        assert.deepEqual(events, []);
        await bus.stop();
    });
});
