/**
 * Tests for per-handler middleware configuration.
 *
 * Verifies that handlers can override global middleware with per-handler
 * middleware via the `EventHandlerConfig` object form.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { EventRouterImpl } from "../../src/EventRouter.ts";
import type {
    AdapterContext,
    EventAdapter,
    EventMiddleware,
    EventSubscription,
    PublishOptions,
    RawEvent,
    RawEventHandler,
    RawSubscribeOptions,
} from "../../src/types.ts";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a minimal fake DescMethod compatible with resolveTopicName().
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

function fakeDescService(typeName: string, methods: ReturnType<typeof fakeDescMethod>[]) {
    return { typeName, methods } as any;
}

/**
 * Tracking adapter that captures the RawEventHandler and records publishes.
 */
function createTrackingAdapter() {
    let capturedHandler: RawEventHandler | null = null;
    const published: Array<{ eventType: string; payload: Uint8Array; options?: PublishOptions }> = [];

    const adapter: EventAdapter = {
        name: "tracking",
        async connect(_context?: AdapterContext): Promise<void> {},
        async disconnect(): Promise<void> {
            capturedHandler = null;
        },
        async publish(eventType: string, payload: Uint8Array, options?: PublishOptions): Promise<void> {
            published.push({ eventType, payload, ...(options ? { options } : {}) });
        },
        async subscribe(_patterns: string[], handler: RawEventHandler, _options?: RawSubscribeOptions): Promise<EventSubscription> {
            capturedHandler = handler;
            return { async unsubscribe(): Promise<void> {} };
        },
    };

    return {
        adapter,
        get published() {
            return published;
        },
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

function makeRawEvent(eventType: string, id = "evt-per-handler"): RawEvent {
    return {
        eventId: id,
        eventType,
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

/**
 * Create a tracking middleware that records calls to a shared array.
 */
function createTrackingMiddleware(name: string, log: string[]): EventMiddleware {
    return async (_event, _ctx, next) => {
        log.push(`${name}:before`);
        await next();
        log.push(`${name}:after`);
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe("Per-handler middleware", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("simple function handler uses global middleware", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const method = fakeDescMethod("simpleEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.v1.SimpleService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async () => {
                            log.push("handler");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const { promise } = tracker.deliver(makeRawEvent(EventOptionsSchema.typeName));
        await promise;

        assert.deepEqual(log, ["global:before", "handler", "global:after"]);
    });

    it("object form with handler + middleware uses per-handler middleware", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const method = fakeDescMethod("configEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.v1.ConfigService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        configEvent: {
                            handler: async () => {
                                log.push("handler");
                            },
                            middleware: [createTrackingMiddleware("per-handler", log)],
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const { promise } = tracker.deliver(makeRawEvent(EventOptionsSchema.typeName));
        await promise;

        // Per-handler middleware used instead of global
        assert.deepEqual(log, ["per-handler:before", "handler", "per-handler:after"]);
    });

    it("per-handler middleware overrides global middleware", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const method = fakeDescMethod("overrideEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.v1.OverrideService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        overrideEvent: {
                            handler: async () => {
                                log.push("handler");
                            },
                            middleware: [createTrackingMiddleware("override", log)],
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const { promise } = tracker.deliver(makeRawEvent(EventOptionsSchema.typeName));
        await promise;

        // Global middleware should NOT appear in log
        assert.ok(!log.includes("global:before"), "global middleware should NOT be applied");
        assert.ok(!log.includes("global:after"), "global middleware should NOT be applied");
        assert.deepEqual(log, ["override:before", "handler", "override:after"]);
    });

    it("mixed handlers: simple uses global, config uses per-handler", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const simpleMethod = fakeDescMethod("simpleEvent", "test.v1.SimpleEvent", EventOptionsSchema);
        const configMethod = fakeDescMethod("configEvent", "test.v1.ConfigEvent", EventOptionsSchema);
        const service = fakeDescService("test.v1.MixedService", [simpleMethod, configMethod]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async () => {
                            log.push("simple-handler");
                        },
                        configEvent: {
                            handler: async () => {
                                log.push("config-handler");
                            },
                            middleware: [createTrackingMiddleware("per-handler", log)],
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        // Deliver to simple handler -- global middleware
        const { promise: p1 } = tracker.deliver(makeRawEvent("test.v1.SimpleEvent", "evt-simple"));
        await p1;

        assert.deepEqual(log, ["global:before", "simple-handler", "global:after"]);

        // Reset log
        log.length = 0;

        // Deliver to config handler -- per-handler middleware
        const { promise: p2 } = tracker.deliver(makeRawEvent("test.v1.ConfigEvent", "evt-config"));
        await p2;

        assert.deepEqual(log, ["per-handler:before", "config-handler", "per-handler:after"]);
    });

    it("per-handler middleware with empty array bypasses global middleware", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const method = fakeDescMethod("bypassEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.v1.BypassService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        bypassEvent: {
                            handler: async () => {
                                log.push("handler");
                            },
                            middleware: [], // Empty = no middleware at all
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const { promise } = tracker.deliver(makeRawEvent(EventOptionsSchema.typeName));
        await promise;

        // No middleware executed -- handler called directly
        assert.deepEqual(log, ["handler"]);
    });

    it("config object without middleware field uses global middleware", async () => {
        const tracker = createTrackingAdapter();
        const log: string[] = [];

        const method = fakeDescMethod("noMwFieldEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.v1.NoMwFieldService", [method]);

        bus = createEventBus({
            adapter: tracker.adapter,
            middleware: {
                custom: [createTrackingMiddleware("global", log)],
            },
            routes: [
                (router) => {
                    router.service(service, {
                        noMwFieldEvent: {
                            handler: async () => {
                                log.push("handler");
                            },
                            // No middleware field -- should fall back to global
                        },
                    } as any);
                },
            ],
        });

        await bus.start();

        const { promise } = tracker.deliver(makeRawEvent(EventOptionsSchema.typeName));
        await promise;

        // Global middleware should be used when middleware field is absent
        assert.deepEqual(log, ["global:before", "handler", "global:after"]);
    });
});

// =============================================================================
// EventRouter unit tests for per-handler middleware parsing
// =============================================================================

describe("EventRouter per-handler middleware parsing", () => {
    it("parses simple function handler (no middleware in entry)", () => {
        const method = fakeDescMethod("simpleEvent", "test.v1.SimpleEvent");
        const service = fakeDescService("test.v1.Service", [method]);

        const router = new EventRouterImpl();
        router.service(service, {
            simpleEvent: async () => {},
        } as any);

        assert.equal(router.entries.length, 1);
        assert.equal(router.entries[0]!.middleware, undefined);
        assert.equal(typeof router.entries[0]!.handler, "function");
    });

    it("parses config object with handler and middleware", () => {
        const method = fakeDescMethod("configEvent", "test.v1.ConfigEvent");
        const service = fakeDescService("test.v1.Service", [method]);

        const myMiddleware: EventMiddleware = async (_e, _c, next) => {
            await next();
        };

        const router = new EventRouterImpl();
        router.service(service, {
            configEvent: {
                handler: async () => {},
                middleware: [myMiddleware],
            },
        } as any);

        assert.equal(router.entries.length, 1);
        assert.ok(router.entries[0]!.middleware);
        assert.equal(router.entries[0]!.middleware!.length, 1);
        assert.equal(router.entries[0]!.middleware![0], myMiddleware);
        assert.equal(typeof router.entries[0]!.handler, "function");
    });

    it("parses config object without middleware field (undefined)", () => {
        const method = fakeDescMethod("noMwEvent", "test.v1.NoMwEvent");
        const service = fakeDescService("test.v1.Service", [method]);

        const router = new EventRouterImpl();
        router.service(service, {
            noMwEvent: {
                handler: async () => {},
            },
        } as any);

        assert.equal(router.entries.length, 1);
        assert.equal(router.entries[0]!.middleware, undefined);
        assert.equal(typeof router.entries[0]!.handler, "function");
    });

    it("parses config object with empty middleware array", () => {
        const method = fakeDescMethod("emptyMwEvent", "test.v1.EmptyMwEvent");
        const service = fakeDescService("test.v1.Service", [method]);

        const router = new EventRouterImpl();
        router.service(service, {
            emptyMwEvent: {
                handler: async () => {},
                middleware: [],
            },
        } as any);

        assert.equal(router.entries.length, 1);
        assert.ok(router.entries[0]!.middleware);
        assert.equal(router.entries[0]!.middleware!.length, 0);
        assert.equal(typeof router.entries[0]!.handler, "function");
    });
});
