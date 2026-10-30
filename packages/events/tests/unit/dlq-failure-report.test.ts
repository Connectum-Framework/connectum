/**
 * The dead-letter path reports its own failure and refuses an unusable topic.
 *
 * When the DLQ publish fails the middleware nacks the original without requeue (a requeue would
 * loop a poison event) and does not rethrow, so the event is gone. That is only acceptable when
 * somebody can see it: the bus observer receives a `dlq-failed` event. A `dlq.topic` that is not a
 * non-empty string would make every failed event take that path, so it is refused when the bus or
 * the middleware is created.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { createEventContext } from "../../src/EventContext.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import { dlqMiddleware } from "../../src/middleware/dlq.ts";
import type { EventAdapter, EventBusObserverEvent, RawEvent } from "../../src/types.ts";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRawEvent(): RawEvent {
    return {
        eventId: "evt-dlq-report",
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
const fakeService = { typeName: "test.v1.DlqReportService", methods: [fakeMethod] } as any;

describe("a failed DLQ publish", () => {
    const publishFailure = new Error("dlq broker down");

    it("is reported to the bus observer with the dead-letter topic, the event and the error", async () => {
        const real = MemoryAdapter();
        const adapter: EventAdapter = {
            ...real,
            publish: (topic, payload, options) => (topic === "report.dlq" ? Promise.reject(publishFailure) : real.publish(topic, payload, options)),
        };
        const observed: EventBusObserverEvent[] = [];
        const bus = createEventBus({
            adapter,
            observer: (event) => void observed.push(event),
            middleware: { retry: { maxRetries: 0 }, dlq: { topic: "report.dlq" } },
            routes: [
                (router) => {
                    router.service(fakeService, {
                        simpleEvent: async () => {
                            throw new Error("poison");
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();
        await bus.publish(EventOptionsSchema, create(EventOptionsSchema, {}));
        await sleep(50);
        await bus.stop();

        assert.equal(observed.length, 1);
        const event = observed[0];
        assert.ok(event !== undefined && event.type === "dlq-failed");
        assert.equal(event.topic, "report.dlq");
        assert.equal(event.eventType, EventOptionsSchema.typeName);
        assert.equal(typeof event.eventId, "string");
        assert.equal(event.error, publishFailure);
    });

    it("is passed to the callback of dlqMiddleware, and the original is still nacked without requeue", async () => {
        const reported: Array<{ topic: string; eventType: string; eventId: string; error: unknown }> = [];
        const nacks: Array<boolean | undefined> = [];
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => undefined,
            onNack: async (requeue) => {
                nacks.push(requeue);
            },
        });
        const mw = dlqMiddleware({ topic: "report.dlq" }, { publish: () => Promise.reject(publishFailure) }, (failure) => {
            reported.push(failure);
        });

        await mw(makeRawEvent(), ctx, async () => {
            throw new Error("poison");
        });

        assert.deepEqual(reported, [{ topic: "report.dlq", eventType: EventOptionsSchema.typeName, eventId: "evt-dlq-report", error: publishFailure }]);
        assert.deepEqual(nacks, [false]);
    });

    it("is not reported when the publish succeeds but the ack fails: the dead-letter copy exists", async () => {
        const reported: unknown[] = [];
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => {
                throw new Error("ack failed");
            },
            onNack: async () => undefined,
        });
        const mw = dlqMiddleware({ topic: "report.dlq" }, { publish: async () => undefined }, (failure) => {
            reported.push(failure);
        });

        await mw(makeRawEvent(), ctx, async () => {
            throw new Error("poison");
        });

        assert.deepEqual(reported, []);
    });

    it("does not stop the dead-letter path when the callback itself throws", async () => {
        const nacks: Array<boolean | undefined> = [];
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => undefined,
            onNack: async (requeue) => {
                nacks.push(requeue);
            },
        });
        const mw = dlqMiddleware({ topic: "report.dlq" }, { publish: () => Promise.reject(publishFailure) }, () => {
            throw new Error("observer bug");
        });

        await mw(makeRawEvent(), ctx, async () => {
            throw new Error("poison");
        });

        assert.deepEqual(nacks, [false]);
    });
});

describe("an async dlqMiddleware callback that rejects", () => {
    it("does not become an unhandled rejection and does not change the nack", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            const nacks: Array<boolean | undefined> = [];
            const ctx = createEventContext({
                raw: makeRawEvent(),
                signal: AbortSignal.timeout(1000),
                onAck: async () => undefined,
                onNack: async (requeue) => {
                    nacks.push(requeue);
                },
            });
            const mw = dlqMiddleware({ topic: "report.dlq" }, { publish: () => Promise.reject(new Error("dlq down")) }, async () => {
                throw new Error("notification failed");
            });

            await mw(makeRawEvent(), ctx, async () => {
                throw new Error("poison");
            });
            await sleep(30);

            assert.deepEqual(nacks, [false]);
            assert.deepEqual(unhandled, []);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

describe("dlq.topic validation", () => {
    for (const [label, value, errorType] of [
        ["an empty string", "", RangeError],
        ["a blank string", "   ", RangeError],
        ["undefined", undefined, TypeError],
        ["null", null, TypeError],
        ["a number", 5, TypeError],
        ["an object", {}, TypeError],
    ] as const) {
        it(`createEventBus refuses ${label}, naming the option and the value`, () => {
            assert.throws(
                () => createEventBus({ adapter: MemoryAdapter(), middleware: { dlq: { topic: value as unknown as string } } }),
                (error: unknown) => error instanceof errorType && error.message.includes("dlqMiddleware") && error.message.includes("topic") && error.message.includes(String(value === "" ? '""' : value)),
            );
        });
    }

    it("createEventBus refuses an empty options object", () => {
        assert.throws(
            () => createEventBus({ adapter: MemoryAdapter(), middleware: { dlq: {} as never } }),
            (error: unknown) => error instanceof TypeError && error.message.includes("topic") && error.message.includes("undefined"),
        );
    });

    it("dlqMiddleware refuses the same values when used on its own", () => {
        assert.throws(() => dlqMiddleware({ topic: "" }, { publish: async () => undefined }), RangeError);
    });

    it("a usable topic is accepted and used as given", async () => {
        const published: string[] = [];
        const ctx = createEventContext({ raw: makeRawEvent(), signal: AbortSignal.timeout(1000), onAck: async () => undefined, onNack: async () => undefined });
        const mw = dlqMiddleware(
            { topic: "orders.dlq" },
            {
                publish: async (topic) => {
                    published.push(topic);
                },
            },
        );
        await mw(makeRawEvent(), ctx, async () => {
            throw new Error("poison");
        });
        assert.deepEqual(published, ["orders.dlq"]);
    });
});
