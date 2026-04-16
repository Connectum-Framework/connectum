/**
 * Unit tests for topic auto-resolve in EventBus.publish().
 *
 * Verifies that publish() automatically resolves the topic from proto
 * `(connectum.events.v1.event).topic` option when no explicit topic is
 * provided in PublishOptions. Tests the priority chain:
 * 1. Explicit `publishOptions.topic` (override)
 * 2. Proto annotation topic (auto-resolved from registered routes)
 * 3. `schema.typeName` (fallback, backward compatible)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { EventOptionsSchema, event } from "#gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import type {
    AdapterContext,
    EventAdapter,
    EventSubscription,
    PublishOptions,
    RawEventHandler,
    RawSubscribeOptions,
} from "../../src/types.ts";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a fake DescMethod without any custom event option.
 * `proto.options` is undefined so hasOption() returns false,
 * falling back to `method.input.typeName`.
 */
function fakeDescMethod(localName: string, typeName: string, realInput?: any) {
    const input = realInput
        ? Object.create(realInput, { typeName: { value: typeName, writable: false, enumerable: true } })
        : { typeName };

    return {
        localName,
        input,
        proto: { options: undefined },
    } as any;
}

/**
 * Create a fake DescMethod with the `(connectum.events.v1.event).topic` option set.
 * Uses real proto create + setExtension to produce valid MethodOptions.
 */
function fakeDescMethodWithTopic(localName: string, inputTypeName: string, topic: string, realInput?: any) {
    const methodOptions = create(MethodOptionsSchema);
    const eventOptions = create(EventOptionsSchema, { topic });
    setExtension(methodOptions, event, eventOptions);

    const input = realInput
        ? Object.create(realInput, { typeName: { value: inputTypeName, writable: false, enumerable: true } })
        : { typeName: inputTypeName };

    return {
        localName,
        input,
        proto: { options: methodOptions },
    } as any;
}

function fakeDescService(typeName: string, methods: ReturnType<typeof fakeDescMethod>[]) {
    return { typeName, methods } as any;
}

/**
 * Tracking adapter that records all publish() calls.
 */
function createTrackingAdapter() {
    const published: Array<{ eventType: string; payload: Uint8Array; options?: PublishOptions }> = [];

    const adapter: EventAdapter = {
        name: "tracking",
        async connect(_context?: AdapterContext): Promise<void> {},
        async disconnect(): Promise<void> {},
        async publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
            published.push({ eventType, payload, ...(options ? { options } : {}) });
        },
        async subscribe(_patterns: string[], _handler: RawEventHandler, _options?: RawSubscribeOptions): Promise<EventSubscription> {
            return { async unsubscribe(): Promise<void> {} };
        },
    };

    return { adapter, published };
}

// =============================================================================
// TESTS
// =============================================================================

describe("EventBus topic auto-resolve", () => {
    it("publish without explicit topic uses topic from proto annotation", async () => {
        const { adapter, published } = createTrackingAdapter();

        // Route with custom topic via proto option
        const method = fakeDescMethodWithTopic(
            "taskCreated",
            EventOptionsSchema.typeName,
            "meshai.task.created",
            EventOptionsSchema,
        );
        const service = fakeDescService("meshai.v1.TaskEventService", [method]);

        const bus = createEventBus({
            adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        taskCreated: async () => {},
                    } as any);
                },
            ],
        });

        await bus.start();

        // Publish using the same schema whose typeName matches the registered route's input
        await bus.publish(EventOptionsSchema, {} as any);

        assert.equal(published.length, 1);
        assert.equal(
            published[0]!.eventType,
            "meshai.task.created",
            "should use proto annotation topic, not schema.typeName",
        );

        await bus.stop();
    });

    it("publish with explicit topic overrides proto annotation", async () => {
        const { adapter, published } = createTrackingAdapter();

        const method = fakeDescMethodWithTopic(
            "taskCreated",
            EventOptionsSchema.typeName,
            "meshai.task.created",
            EventOptionsSchema,
        );
        const service = fakeDescService("meshai.v1.TaskEventService", [method]);

        const bus = createEventBus({
            adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        taskCreated: async () => {},
                    } as any);
                },
            ],
        });

        await bus.start();

        // Explicit topic override
        await bus.publish(EventOptionsSchema, {} as any, { topic: "override.topic" });

        assert.equal(published.length, 1);
        assert.equal(
            published[0]!.eventType,
            "override.topic",
            "explicit publishOptions.topic should take highest priority",
        );

        await bus.stop();
    });

    it("publish message without registered route falls back to schema.typeName", async () => {
        const { adapter, published } = createTrackingAdapter();

        // Register a route for a DIFFERENT message type
        const method = fakeDescMethod("orderCreated", "order.v1.OrderCreated", EventOptionsSchema);
        const service = fakeDescService("order.v1.OrderEventService", [method]);

        const bus = createEventBus({
            adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        orderCreated: async () => {},
                    } as any);
                },
            ],
        });

        await bus.start();

        // Publish using EventOptionsSchema but the route's input typeName is
        // "order.v1.OrderCreated" (different from EventOptionsSchema.typeName).
        // So publishTopicMap won't have a match for EventOptionsSchema.typeName,
        // and it falls back to schema.typeName.
        await bus.publish(EventOptionsSchema, {} as any);

        assert.equal(published.length, 1);
        assert.equal(
            published[0]!.eventType,
            EventOptionsSchema.typeName,
            "should fall back to schema.typeName when no route matches the input typeName",
        );

        await bus.stop();
    });

    it("publish without routes falls back to schema.typeName (no routes registered)", async () => {
        const { adapter, published } = createTrackingAdapter();

        const bus = createEventBus({
            adapter,
            routes: [],
        });

        await bus.start();

        await bus.publish(EventOptionsSchema, {} as any);

        assert.equal(published.length, 1);
        assert.equal(
            published[0]!.eventType,
            EventOptionsSchema.typeName,
            "should use schema.typeName when no routes are registered",
        );

        await bus.stop();
    });

    it("round-trip consistency: publish topic matches subscribe topic", async () => {
        const customTopic = "meshai.task.created";
        let capturedHandler: RawEventHandler | null = null;
        const publishedEvents: Array<{ eventType: string; payload: Uint8Array }> = [];
        const receivedEvents: Array<{ eventType: string }> = [];

        // Adapter that captures handler and delivers published events to subscribers
        const roundTripAdapter: EventAdapter = {
            name: "round-trip",
            async connect(): Promise<void> {},
            async disconnect(): Promise<void> {},
            async publish(eventType: string, payload: Uint8Array): Promise<void> {
                publishedEvents.push({ eventType, payload });
                // Deliver to subscriber if topic matches
                if (capturedHandler) {
                    await capturedHandler(
                        {
                            eventId: `evt-${publishedEvents.length}`,
                            eventType,
                            payload,
                            publishedAt: new Date(),
                            attempt: 1,
                            metadata: new Map(),
                        },
                        async () => {},
                        async () => {},
                    );
                }
            },
            async subscribe(_patterns: string[], handler: RawEventHandler): Promise<EventSubscription> {
                capturedHandler = handler;
                return { async unsubscribe(): Promise<void> {} };
            },
        };

        const method = fakeDescMethodWithTopic(
            "taskCreated",
            EventOptionsSchema.typeName,
            customTopic,
            EventOptionsSchema,
        );
        const service = fakeDescService("meshai.v1.TaskEventService", [method]);

        const bus = createEventBus({
            adapter: roundTripAdapter,
            routes: [
                (router) => {
                    router.service(service, {
                        taskCreated: async (_event: unknown, ctx: { eventType: string }) => {
                            receivedEvents.push({ eventType: ctx.eventType });
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        // Publish without explicit topic -- should auto-resolve to proto annotation topic
        await bus.publish(EventOptionsSchema, {} as any);

        assert.equal(publishedEvents.length, 1);
        assert.equal(
            publishedEvents[0]!.eventType,
            customTopic,
            "published eventType should match proto annotation topic",
        );

        assert.equal(receivedEvents.length, 1);
        assert.equal(
            receivedEvents[0]!.eventType,
            customTopic,
            "received eventType should match published eventType",
        );

        await bus.stop();
    });

    it("publishTopicMap is repopulated on start-stop-start cycle", async () => {
        const { adapter, published } = createTrackingAdapter();

        const method = fakeDescMethodWithTopic(
            "taskCreated",
            EventOptionsSchema.typeName,
            "meshai.task.created",
            EventOptionsSchema,
        );
        const service = fakeDescService("meshai.v1.TaskEventService", [method]);

        const bus = createEventBus({
            adapter,
            routes: [
                (router) => {
                    router.service(service, {
                        taskCreated: async () => {},
                    } as any);
                },
            ],
        });

        // First cycle
        await bus.start();
        await bus.publish(EventOptionsSchema, {} as any);
        assert.equal(published[0]!.eventType, "meshai.task.created");
        await bus.stop();

        // Second cycle -- publishTopicMap should be repopulated
        await bus.start();
        await bus.publish(EventOptionsSchema, {} as any);
        assert.equal(published[1]!.eventType, "meshai.task.created");
        await bus.stop();
    });
});
