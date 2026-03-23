/**
 * Integration tests for the full EventBus pipeline:
 * EventBus + middleware (retry, DLQ, custom) + MemoryAdapter.
 *
 * These tests verify end-to-end behavior that cannot be covered
 * by unit tests of individual components in isolation.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type {
    AdapterContext,
    EventAdapter,
    EventContext,
    EventMiddleware,
    EventSubscription,
    PublishOptions,
    RawEvent,
    RawEventHandler,
    RawSubscribeOptions,
} from "../../src/types.ts";
import { matchPattern } from "../../src/wildcard.ts";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a minimal fake DescMethod compatible with resolveTopicName().
 *
 * resolveTopicName calls `hasOption(method, event)` which accesses
 * `method.proto.options`. We provide `proto: { options: undefined }`
 * so hasOption returns false, falling back to `method.input.typeName`.
 *
 * For tests that invoke the handler (and thus trigger fromBinary),
 * `input` must be a real DescMessage schema like EventOptionsSchema.
 */
function fakeDescMethod(localName: string, typeName: string, realInput?: any) {
    // When realInput is provided, we need fromBinary-compatible schema
    // but with a custom typeName for topic resolution.
    // Wrap the real input, overriding typeName while preserving schema structure.
    const input = realInput
        ? Object.create(realInput, { typeName: { value: typeName, writable: false, enumerable: true } })
        : { typeName };

    return {
        localName,
        input,
        proto: { options: undefined },
    } as any;
}

function fakeDescService(typeName: string, methods: ReturnType<typeof fakeDescMethod>[]) {
    return { typeName, methods } as any;
}

/**
 * Tracking adapter that records all publish() calls and captures
 * the RawEventHandler from subscribe(), allowing both controlled
 * delivery and DLQ publish inspection.
 *
 * Unlike MemoryAdapter, this adapter exposes internal calls for assertions.
 */
function createTrackingAdapter() {
    let capturedHandler: RawEventHandler | null = null;
    let connected = false;
    const published: Array<{ eventType: string; payload: Uint8Array; options?: PublishOptions }> = [];
    const subscribedPatterns: string[][] = [];

    const adapter: EventAdapter = {
        name: "tracking",

        async connect(_context?: AdapterContext): Promise<void> {
            connected = true;
        },

        async disconnect(): Promise<void> {
            capturedHandler = null;
            connected = false;
        },

        async publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
            published.push({ eventType, payload, ...(options ? { options } : {}) });

            // If there is a subscriber whose pattern matches, deliver the event
            if (capturedHandler && connected) {
                const handler = capturedHandler;
                const patterns = subscribedPatterns.flat();
                const matches = patterns.some((p) => matchPattern(p, eventType));
                if (matches) {
                    const event: RawEvent = {
                        eventId: `pub-${published.length}`,
                        eventType,
                        payload,
                        publishedAt: new Date(),
                        attempt: 1,
                        metadata: new Map(Object.entries(options?.metadata ?? {})),
                    };
                    const noopAck = async (): Promise<void> => {};
                    const noopNack = async (_requeue?: boolean): Promise<void> => {};
                    await handler(event, noopAck, noopNack);
                }
            }
        },

        async subscribe(patterns: string[], handler: RawEventHandler, _options?: RawSubscribeOptions): Promise<EventSubscription> {
            capturedHandler = handler;
            subscribedPatterns.push(patterns);
            return {
                async unsubscribe(): Promise<void> {},
            };
        },
    };

    return {
        adapter,
        get published() {
            return published;
        },
        get handler() {
            return capturedHandler;
        },
        get connected() {
            return connected;
        },
        /**
         * Deliver an event directly through the captured handler.
         * Returns the handler promise and ack/nack tracking.
         */
        deliver(event: RawEvent) {
            const handler = capturedHandler;
            assert.ok(handler, "No handler captured -- was subscribe() called?");

            const calls: string[] = [];

            const promise = handler(
                event,
                async () => {
                    calls.push("ack");
                },
                async (requeue?: boolean) => {
                    calls.push(requeue ? "nack-requeue" : "nack");
                },
            );

            return { promise, calls };
        },
    };
}

/**
 * Create a RawEvent for testing.
 */
function makeRawEvent(eventType: string, id = "evt-pipeline"): RawEvent {
    return {
        eventId: id,
        eventType,
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

// =============================================================================
// 1. FULL PIPELINE: EventBus + retry + DLQ + MemoryAdapter
// =============================================================================

describe("Full pipeline: EventBus + retry + DLQ", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("handler fails all retries and event lands in DLQ", async () => {
        const tracker = createTrackingAdapter();
        let handlerCallCount = 0;

        const method = fakeDescMethod("processOrder", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.OrderService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                retry: {
                    maxRetries: 2,
                    backoff: "fixed",
                    initialDelay: 1, // 1ms for fast tests
                },
                dlq: {
                    topic: "pipeline.dlq",
                },
            },
            routes: [
                (router) => {
                    router.service(service, {
                        processOrder: async () => {
                            handlerCallCount++;
                            throw new Error("processing failed");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-retry-dlq");
        const { promise, calls } = tracker.deliver(event);

        // Should NOT throw -- DLQ middleware catches the error after retry exhaustion
        await promise;

        // Handler was called 1 initial + 2 retries = 3 times
        assert.equal(handlerCallCount, 3, "handler should be called 1 + maxRetries times");

        // Original event was acked (DLQ middleware acks after publishing to DLQ)
        assert.deepEqual(calls, ["ack"], "original event should be acked by DLQ middleware");

        // DLQ event was published
        const dlqPublish = tracker.published.find((p) => p.eventType === "pipeline.dlq");
        assert.ok(dlqPublish, "DLQ event should have been published");
        assert.equal(dlqPublish.options?.metadata?.["dlq.original-topic"], EventOptionsSchema.typeName);
        assert.equal(dlqPublish.options?.metadata?.["dlq.original-id"], "evt-retry-dlq");
        assert.equal(dlqPublish.options?.metadata?.["dlq.error"], "Error");
    });

    it("handler succeeds on second retry -- DLQ is NOT triggered", async () => {
        const tracker = createTrackingAdapter();
        let handlerCallCount = 0;

        const method = fakeDescMethod("processPayment", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.PaymentService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                retry: {
                    maxRetries: 3,
                    backoff: "fixed",
                    initialDelay: 1,
                },
                dlq: {
                    topic: "pipeline.dlq",
                },
            },
            routes: [
                (router) => {
                    router.service(service, {
                        processPayment: async () => {
                            handlerCallCount++;
                            if (handlerCallCount < 3) {
                                throw new Error("transient failure");
                            }
                            // Succeeds on 3rd call (2nd retry)
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-partial-retry");
        const { promise, calls } = tracker.deliver(event);

        await promise;

        assert.equal(handlerCallCount, 3, "handler should be called until success");
        assert.deepEqual(calls, ["ack"], "event should be auto-acked on success");

        // No DLQ publish
        const dlqPublish = tracker.published.find((p) => p.eventType === "pipeline.dlq");
        assert.equal(dlqPublish, undefined, "DLQ should NOT be triggered when handler eventually succeeds");
    });
});

// =============================================================================
// 2. CUSTOM MIDDLEWARE ORDERING
// =============================================================================

describe("Custom middleware ordering", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("custom middleware runs outermost, then DLQ, then retry (innermost)", async () => {
        const tracker = createTrackingAdapter();
        const executionOrder: string[] = [];

        const customMiddleware: EventMiddleware = async (_event, _ctx, next) => {
            executionOrder.push("custom:before");
            await next();
            executionOrder.push("custom:after");
        };

        const method = fakeDescMethod("trackEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.TrackService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [customMiddleware],
                retry: {
                    maxRetries: 1,
                    backoff: "fixed",
                    initialDelay: 1,
                },
                dlq: {
                    topic: "ordering.dlq",
                },
            },
            routes: [
                (router) => {
                    router.service(service, {
                        trackEvent: async () => {
                            executionOrder.push("handler");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-ordering");
        const { promise } = tracker.deliver(event);
        await promise;

        // On success: custom:before -> (DLQ passes through) -> (retry passes through) -> handler -> custom:after
        assert.equal(executionOrder[0], "custom:before", "custom middleware should run first (outermost)");
        assert.equal(executionOrder[1], "handler", "handler runs innermost");
        assert.equal(executionOrder[2], "custom:after", "custom middleware post-handler runs last");
    });

    it("custom middleware sees error from DLQ on handler failure", async () => {
        const tracker = createTrackingAdapter();
        const executionOrder: string[] = [];
        let customCaughtError = false;

        const customMiddleware: EventMiddleware = async (_event, _ctx, next) => {
            executionOrder.push("custom:before");
            try {
                await next();
            } catch (error) {
                // DLQ middleware catches errors, so custom should NOT see an error
                // when DLQ successfully publishes and acks
                customCaughtError = true;
                throw error;
            }
            executionOrder.push("custom:after");
        };

        const method = fakeDescMethod("failEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.FailService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [customMiddleware],
                retry: {
                    maxRetries: 0,
                    backoff: "fixed",
                    initialDelay: 1,
                },
                dlq: {
                    topic: "ordering.dlq",
                },
            },
            routes: [
                (router) => {
                    router.service(service, {
                        failEvent: async () => {
                            executionOrder.push("handler:throw");
                            throw new Error("always fails");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-ordering-fail");
        const { promise } = tracker.deliver(event);
        await promise;

        // DLQ catches the error from retry, publishes to DLQ, and acks -- no error propagates to custom
        assert.equal(customCaughtError, false, "DLQ should swallow the error; custom middleware should not catch");
        assert.deepEqual(executionOrder, ["custom:before", "handler:throw", "custom:after"]);
    });

    it("multiple custom middleware execute in registration order", async () => {
        const tracker = createTrackingAdapter();
        const executionOrder: string[] = [];

        const middlewareA: EventMiddleware = async (_event, _ctx, next) => {
            executionOrder.push("A:before");
            await next();
            executionOrder.push("A:after");
        };

        const middlewareB: EventMiddleware = async (_event, _ctx, next) => {
            executionOrder.push("B:before");
            await next();
            executionOrder.push("B:after");
        };

        const method = fakeDescMethod("multiMwEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.MultiMwService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [middlewareA, middlewareB],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        multiMwEvent: async () => {
                            executionOrder.push("handler");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-multi-mw");
        const { promise } = tracker.deliver(event);
        await promise;

        // Onion model: A wraps B wraps handler
        assert.deepEqual(executionOrder, ["A:before", "B:before", "handler", "B:after", "A:after"]);
    });
});

// =============================================================================
// 3. EXPLICIT ACK/NACK
// =============================================================================

describe("Explicit ack/nack", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("explicit ctx.ack() prevents auto-ack from firing twice", async () => {
        const tracker = createTrackingAdapter();

        const method = fakeDescMethod("explicitAckEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.ExplicitAckService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        explicitAckEvent: async (_event: unknown, ctx: EventContext) => {
                            await ctx.ack();
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-explicit-ack");
        const { promise, calls } = tracker.deliver(event);
        await promise;

        // ctx.ack() fires the adapter ack, and auto-ack should NOT fire again
        // (EventContext is idempotent -- second ack is a no-op)
        assert.deepEqual(calls, ["ack"], "ack should be called exactly once");
    });

    it("explicit ctx.nack(false) calls adapter nack without requeue", async () => {
        const tracker = createTrackingAdapter();

        const method = fakeDescMethod("explicitNackEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.ExplicitNackService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        explicitNackEvent: async (_event: unknown, ctx: EventContext) => {
                            await ctx.nack(false);
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-explicit-nack");
        const { promise, calls } = tracker.deliver(event);
        await promise;

        // ctx.nack(false) fires adapter nack without requeue
        assert.deepEqual(calls, ["nack"], "nack should be called without requeue");
    });

    it("explicit ctx.nack(true) calls adapter nack with requeue", async () => {
        const tracker = createTrackingAdapter();

        const method = fakeDescMethod("nackRequeueEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.NackRequeueService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        nackRequeueEvent: async (_event: unknown, ctx: EventContext) => {
                            await ctx.nack(true);
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-nack-requeue");
        const { promise, calls } = tracker.deliver(event);
        await promise;

        assert.deepEqual(calls, ["nack-requeue"], "nack should be called with requeue=true");
    });

    it("explicit ctx.ack() followed by ctx.nack() is idempotent (second call ignored)", async () => {
        const tracker = createTrackingAdapter();

        const method = fakeDescMethod("doubleSettleEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.DoubleSettleService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        doubleSettleEvent: async (_event: unknown, ctx: EventContext) => {
                            await ctx.ack();
                            await ctx.nack(false); // should be ignored
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const event = makeRawEvent(EventOptionsSchema.typeName, "evt-double-settle");
        const { promise, calls } = tracker.deliver(event);
        await promise;

        // Only the first ack should fire
        assert.deepEqual(calls, ["ack"], "only the first settlement should take effect");
    });
});

// =============================================================================
// 4. PUBLISH WITH OPTIONS
// =============================================================================

describe("Publish with options", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("publish with topic override sends event to custom topic", async () => {
        const tracker = createTrackingAdapter();

        bus = createEventBus({
            adapter: tracker.adapter,
        });

        await bus.start();

        const fakeSchema = EventOptionsSchema;
        await bus.publish(fakeSchema, {} as any, { topic: "custom.override.topic" });

        assert.equal(tracker.published.length, 1);
        assert.equal(tracker.published[0]!.eventType, "custom.override.topic");
    });

    it("publish without topic override uses schema.typeName", async () => {
        const tracker = createTrackingAdapter();

        bus = createEventBus({
            adapter: tracker.adapter,
        });

        await bus.start();

        const fakeSchema = EventOptionsSchema;
        await bus.publish(fakeSchema, {} as any);

        assert.equal(tracker.published.length, 1);
        assert.equal(tracker.published[0]!.eventType, EventOptionsSchema.typeName);
    });

    it("publish with metadata passes metadata to adapter", async () => {
        const tracker = createTrackingAdapter();

        bus = createEventBus({
            adapter: tracker.adapter,
        });

        await bus.start();

        const metadata = {
            "correlation-id": "req-12345",
            "source": "pipeline-test",
        };

        await bus.publish(EventOptionsSchema, {} as any, { metadata });

        assert.equal(tracker.published.length, 1);
        assert.deepEqual(tracker.published[0]!.options?.metadata, metadata);
    });

    it("publish with both topic and metadata works together", async () => {
        const tracker = createTrackingAdapter();

        bus = createEventBus({
            adapter: tracker.adapter,
        });

        await bus.start();

        await bus.publish(EventOptionsSchema, {} as any, {
            topic: "notifications.email",
            metadata: { "priority": "high" },
        });

        assert.equal(tracker.published.length, 1);
        assert.equal(tracker.published[0]!.eventType, "notifications.email");
        assert.equal(tracker.published[0]!.options?.metadata?.priority, "high");
    });
});

// =============================================================================
// 5. WILDCARD SUBSCRIPTION MATCHING
// =============================================================================

describe("Wildcard subscription matching", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("wildcard '*' matches single segment -- handler receives matching events", async () => {
        const tracker = createTrackingAdapter();
        const received: string[] = [];

        // Use a wildcard topic pattern: "orders.*" matches "orders.created", "orders.shipped"
        // but NOT "orders.created.v2" or "inventory.updated"
        // realInput must be a real DescMessage schema for fromBinary to work
        const method = fakeDescMethod("handleOrder", "orders.*", EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.WildcardService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        handleOrder: async (_event: unknown, ctx: EventContext) => {
                            received.push(ctx.eventType);
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        // Deliver "orders.created" -- should match "orders.*"
        const event1 = makeRawEvent("orders.created", "evt-wc-1");
        const { promise: p1, calls: c1 } = tracker.deliver(event1);
        await p1;
        assert.deepEqual(c1, ["ack"]);

        // Deliver "orders.shipped" -- should match "orders.*"
        const event2 = makeRawEvent("orders.shipped", "evt-wc-2");
        const { promise: p2, calls: c2 } = tracker.deliver(event2);
        await p2;
        assert.deepEqual(c2, ["ack"]);

        // Deliver "inventory.updated" -- should NOT match "orders.*"
        const event3 = makeRawEvent("inventory.updated", "evt-wc-3");
        const { promise: p3, calls: c3 } = tracker.deliver(event3);
        await p3;
        // Unmatched events are auto-acked (skip behavior)
        assert.deepEqual(c3, ["ack"]);

        // Only orders events were processed by the handler
        assert.deepEqual(received, ["orders.created", "orders.shipped"]);
    });

    it("wildcard '>' matches one or more trailing segments", async () => {
        const tracker = createTrackingAdapter();
        const received: string[] = [];

        // "orders.>" matches "orders.created", "orders.created.v2", etc.
        // realInput must be a real DescMessage schema for fromBinary to work
        const method = fakeDescMethod("handleOrderDeep", "orders.>", EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.DeepWildcardService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        handleOrderDeep: async (_event: unknown, ctx: EventContext) => {
                            received.push(ctx.eventType);
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        // "orders.created" -- matches "orders.>"
        const event1 = makeRawEvent("orders.created", "evt-deep-1");
        const { promise: p1 } = tracker.deliver(event1);
        await p1;

        // "orders.created.v2" -- matches "orders.>"
        const event2 = makeRawEvent("orders.created.v2", "evt-deep-2");
        const { promise: p2 } = tracker.deliver(event2);
        await p2;

        // "inventory.updated" -- does NOT match "orders.>"
        const event3 = makeRawEvent("inventory.updated", "evt-deep-3");
        const { promise: p3 } = tracker.deliver(event3);
        await p3;

        assert.deepEqual(received, ["orders.created", "orders.created.v2"]);
    });

    it("exact topic match takes priority over wildcard", async () => {
        const tracker = createTrackingAdapter();
        const exactReceived: string[] = [];
        const wildcardReceived: string[] = [];

        // Two handlers: one exact, one wildcard
        // realInput must be a real DescMessage schema for fromBinary to work
        const exactMethod = fakeDescMethod("handleExact", "orders.created", EventOptionsSchema);
        const wildcardMethod = fakeDescMethod("handleWild", "orders.*", EventOptionsSchema);
        const service = fakeDescService("pipeline.v1.PriorityService", [exactMethod, wildcardMethod]);

        bus = createEventBus({
            adapter: tracker.adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        handleExact: async (_event: unknown, ctx: EventContext) => {
                            exactReceived.push(ctx.eventType);
                        },
                        handleWild: async (_event: unknown, ctx: EventContext) => {
                            wildcardReceived.push(ctx.eventType);
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        // "orders.created" -- exact match exists, should go to exact handler
        const event1 = makeRawEvent("orders.created", "evt-priority-1");
        const { promise: p1 } = tracker.deliver(event1);
        await p1;

        // "orders.shipped" -- no exact match, wildcard should catch it
        const event2 = makeRawEvent("orders.shipped", "evt-priority-2");
        const { promise: p2 } = tracker.deliver(event2);
        await p2;

        // The exact handler gets "orders.created" because topicHandlerMap.get() matches first
        assert.deepEqual(exactReceived, ["orders.created"]);
        assert.deepEqual(wildcardReceived, ["orders.shipped"]);
    });
});
