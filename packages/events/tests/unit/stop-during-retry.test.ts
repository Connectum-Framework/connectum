/**
 * A stop that interrupts a retry pause must not dead-letter the event.
 *
 * An event that waits out a backoff has failed once and still has retry budget. When the shutdown
 * signal or the drain abort ends that wait, the event is returned to the broker (`nack(true)`) so
 * it is handled after the restart; it is not copied to the dead-letter topic with the abort as its
 * "error". An abort that comes from the per-event `handlerTimeout` is different: the event ran out
 * of time, so it is still dead-lettered.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { createEventContext } from "../../src/EventContext.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import { retryMiddleware } from "../../src/middleware/retry.ts";
import type { EventAdapter, EventBusOptions, EventSubscription, PublishOptions, RawEvent, RawEventHandler } from "../../src/types.ts";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRawEvent(): RawEvent {
    return {
        eventId: "evt-stop-retry",
        eventType: EventOptionsSchema.typeName,
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

const fakeMethod = {
    localName: "simpleEvent",
    input: Object.create(EventOptionsSchema, { typeName: { value: EventOptionsSchema.typeName, writable: false, enumerable: true } }),
    proto: { options: undefined },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;
// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = { typeName: "test.v1.StopRetryService", methods: [fakeMethod] } as any;

/** What the broker would see: every settlement of the delivery and every publish to the DLQ. */
interface Outcome {
    readonly acks: number[];
    readonly nacks: Array<boolean | undefined>;
    readonly published: Array<{ readonly topic: string; readonly metadata: Record<string, string> | undefined }>;
    handlerCalls: number;
}

/** A bus whose handler always fails; the raw handler is captured so the test can deliver an event. */
function makeBus(extra: Partial<EventBusOptions>) {
    let captured: RawEventHandler | null = null;
    const outcome: Outcome = { acks: [], nacks: [], published: [], handlerCalls: 0 };
    const adapter: EventAdapter = {
        name: "stop-retry",
        connect: async () => undefined,
        disconnect: async () => undefined,
        publish: async (topic: string, _payload: Uint8Array, options?: PublishOptions) => {
            outcome.published.push({ topic, metadata: options?.metadata });
        },
        subscribe: async (_patterns, handler): Promise<EventSubscription> => {
            captured = handler;
            return { unsubscribe: async () => undefined };
        },
    };
    const bus = createEventBus({
        adapter,
        routes: [
            (router) => {
                router.service(fakeService, {
                    simpleEvent: async () => {
                        outcome.handlerCalls += 1;
                        throw new Error("transient failure");
                    },
                    // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                } as any);
            },
        ],
        ...extra,
    });
    const deliver = (): Promise<void> =>
        (captured as unknown as RawEventHandler)(
            makeRawEvent(),
            async () => {
                outcome.acks.push(Date.now());
            },
            async (requeue) => {
                outcome.nacks.push(requeue);
            },
        );
    return { bus, deliver, outcome };
}

describe("retry middleware when the signal aborts during the backoff pause", () => {
    function makeCtx(signal: AbortSignal) {
        const nacks: Array<boolean | undefined> = [];
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal,
            onAck: async () => undefined,
            onNack: async (requeue) => {
                nacks.push(requeue);
            },
        });
        return { ctx, nacks };
    }

    for (const [label, reason] of [
        ["the default AbortError of a shutdown signal", undefined],
        ["the string reason of the drain abort", "Drain timeout exceeded"],
    ] as const) {
        it(`returns the event to the broker and does not throw for ${label}`, async () => {
            const controller = new AbortController();
            const { ctx, nacks } = makeCtx(controller.signal);
            const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 5000 });
            let calls = 0;
            setTimeout(() => controller.abort(reason), 30);

            await mw(makeRawEvent(), ctx, async () => {
                calls += 1;
                throw new Error("transient failure");
            });

            assert.equal(calls, 1, "the handler is not entered again after the abort");
            assert.deepEqual(nacks, [true], "exactly one nack, with requeue, so the broker delivers the event again");
        });
    }

    it("still throws when the abort is the per-event timeout: the event ran out of time", async () => {
        const { ctx, nacks } = makeCtx(AbortSignal.timeout(30));
        const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 5000 });

        await assert.rejects(
            () =>
                mw(makeRawEvent(), ctx, async () => {
                    throw new Error("transient failure");
                }),
            (error: unknown) => error instanceof Error && error.name === "TimeoutError",
        );
        assert.deepEqual(nacks, [], "a timed-out event is not returned to the broker by the retry middleware");
    });

    it("settles the event once even when the nack itself fails", async () => {
        const controller = new AbortController();
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: controller.signal,
            onAck: async () => undefined,
            onNack: async () => {
                throw new Error("connection closed");
            },
        });
        const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 5000 });
        setTimeout(() => controller.abort(), 30);

        // The broker redelivers an unacknowledged message by itself; the failed nack must not turn
        // into a handler failure that the dead-letter middleware would then publish.
        await mw(makeRawEvent(), ctx, async () => {
            throw new Error("transient failure");
        });
    });
});

describe("EventBus with retry and dlq when the bus is stopped during a retry pause", () => {
    const middleware = { retry: { maxRetries: 3, backoff: "fixed" as const, initialDelay: 5000 }, dlq: { topic: "stop.retry.dlq" } };

    it("a shutdown signal that ends the pause returns the event to the broker and leaves the DLQ empty", async () => {
        const controller = new AbortController();
        const { bus, deliver, outcome } = makeBus({ middleware });
        await bus.start({ signal: controller.signal });

        const delivery = deliver();
        await sleep(50);
        assert.equal(outcome.handlerCalls, 1, "the first attempt failed and the retry is waiting");
        controller.abort();
        await delivery;

        assert.equal(outcome.handlerCalls, 1, "the retry never ran");
        assert.deepEqual(outcome.published, [], "nothing was dead-lettered");
        assert.deepEqual(outcome.nacks, [true], "the broker is asked to deliver the event again");
        assert.deepEqual(outcome.acks, [], "the event is not acknowledged");
        await bus.stop();
    });

    it("bus.stop() whose drainTimeout ends the pause returns the event to the broker and leaves the DLQ empty", async () => {
        const { bus, deliver, outcome } = makeBus({ middleware, drainTimeout: 40 });
        await bus.start();

        const delivery = deliver();
        await sleep(50);
        assert.equal(outcome.handlerCalls, 1);
        await bus.stop();
        await delivery;

        assert.equal(outcome.handlerCalls, 1);
        assert.deepEqual(outcome.published, []);
        assert.deepEqual(outcome.nacks, [true]);
        assert.deepEqual(outcome.acks, []);
    });

    it("an event whose per-event handlerTimeout ends the pause is still dead-lettered with TimeoutError", async () => {
        const { bus, deliver, outcome } = makeBus({ middleware, handlerTimeout: 40 });
        await bus.start();

        await deliver();

        assert.equal(outcome.handlerCalls, 1);
        assert.equal(outcome.published.length, 1, "the timed-out event reaches the DLQ");
        assert.equal(outcome.published[0]?.topic, "stop.retry.dlq");
        assert.equal(outcome.published[0]?.metadata?.["dlq.error"], "TimeoutError");
        assert.deepEqual(outcome.acks.length, 1, "the original is acknowledged after the DLQ publish");
        await bus.stop();
    });
});

describe("EventBus on MemoryAdapter when the shutdown signal ends a retry pause", () => {
    it("publish() settles, the handler ran once and the DLQ topic received nothing", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const deadLettered: Array<Record<string, string>> = [];
        await adapter.subscribe(
            ["stop.retry.memory.dlq"],
            async (event, ack) => {
                deadLettered.push(Object.fromEntries(event.metadata));
                await ack();
            },
            {},
        );
        let calls = 0;
        const controller = new AbortController();
        const bus = createEventBus({
            adapter,
            middleware: { retry: { maxRetries: 3, backoff: "fixed", initialDelay: 2000 }, dlq: { topic: "stop.retry.memory.dlq" } },
            routes: [
                (router) => {
                    router.service(fakeService, {
                        simpleEvent: async () => {
                            calls += 1;
                            throw new Error("transient failure");
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start({ signal: controller.signal });

        const published = bus.publish(EventOptionsSchema, create(EventOptionsSchema, {}));
        await sleep(100);
        controller.abort();
        await published;
        await bus.stop();

        assert.equal(calls, 1);
        assert.deepEqual(deadLettered, []);
    });
});
