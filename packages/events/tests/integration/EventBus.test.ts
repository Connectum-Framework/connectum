import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import type { EventAdapter, EventSubscription, RawEvent, RawEventHandler } from "../../src/types.ts";

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
    return {
        localName,
        input: realInput ?? { typeName },
        proto: { options: undefined },
    } as any;
}

function fakeDescService(typeName: string, methods: ReturnType<typeof fakeDescMethod>[]) {
    return { typeName, methods } as any;
}

describe("EventBus lifecycle", () => {
    it("starts and stops with MemoryAdapter", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start();
        await bus.stop();
    });

    it("throws on double start", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start();
        await assert.rejects(() => bus.start(), { message: /already started/ });
        await bus.stop();
    });

    it("stop is safe to call when not started", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        // Should not throw
        await bus.stop();
    });

    it("throws when publishing before start", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        // Publish requires a DescMessage schema. Since we just need to test
        // the "not started" guard, any schema-like object will do.
        const fakeSchema = { typeName: "test.Event" } as any;

        await assert.rejects(() => bus.publish(fakeSchema, {} as any), {
            message: /not started/i,
        });
    });

    it("supports start-stop-start cycle", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start();
        await bus.stop();

        // Second start should succeed (shutdown signal reset between cycles)
        await bus.start();
        await bus.stop();
    });

    it("starts with shutdown signal", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        await bus.start({ signal: AbortSignal.timeout(5000) });
        await bus.stop();
    });

    it("resets shutdown signal between start-stop cycles", async () => {
        const bus = createEventBus({
            adapter: MemoryAdapter(),
        });

        // Start with a signal
        await bus.start({ signal: AbortSignal.timeout(5000) });
        await bus.stop();

        // Start again without signal -- should not fail due to stale signal
        await bus.start();
        await bus.stop();
    });
});

describe("EventBus partial startup rollback", () => {
    it("rolls back on subscription failure and allows retry", async () => {
        let connectCount = 0;
        let disconnectCount = 0;
        const failingAdapter: EventAdapter = {
            name: "failing",
            async connect() {
                connectCount++;
            },
            async disconnect() {
                disconnectCount++;
            },
            async publish() {},
            async subscribe(): Promise<EventSubscription> {
                throw new Error("subscribe failed");
            },
        };

        // Use a fake method with proper proto field but fake input for topic resolution.
        // fromBinary is never reached because subscribe() throws first.
        const method = fakeDescMethod("testEvent", "test.TestEvent");
        const service = fakeDescService("test.TestService", [method]);

        const bus = createEventBus({
            adapter: failingAdapter,
            routes: [
                (router) => {
                    router.service(service, {
                        testEvent: async () => {},
                    } as any);
                },
            ],
        });

        // First start should fail at subscribe
        await assert.rejects(() => bus.start(), { message: /subscribe failed/ });

        // Adapter should have been connected then disconnected during rollback
        assert.equal(connectCount, 1);
        assert.equal(disconnectCount, 1);

        // Bus should NOT be in "started" state -- retry should be possible
        // (Previously would throw "already started" if started flag was not reset)
        // Second attempt will also fail, but importantly it does NOT throw "already started"
        await assert.rejects(() => bus.start(), { message: /subscribe failed/ });
        assert.equal(connectCount, 2);
    });
});

describe("EventBus handler error propagation", () => {
    // These tests use a tracking adapter to capture the RawEventHandler registered
    // by EventBus, then deliver events directly to verify ack/nack behavior.
    // The fake method uses EventOptionsSchema as `input` so fromBinary works.

    it("handler error prevents auto-ack (error propagates through adapter)", async () => {
        let capturedHandler: RawEventHandler | null = null;
        const ackCalls: string[] = [];

        const trackingAdapter: EventAdapter = {
            name: "tracking",
            async connect() {},
            async disconnect() {},
            async publish() {},
            async subscribe(_patterns, handler): Promise<EventSubscription> {
                capturedHandler = handler;
                return { async unsubscribe() {} };
            },
        };

        // Use EventOptionsSchema as input -- fromBinary can decode empty Uint8Array to a valid message.
        const method = fakeDescMethod("failEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.FailService", [method]);

        const bus = createEventBus({
            adapter: trackingAdapter,
            routes: [
                (router) => {
                    router.service(service, {
                        failEvent: async () => {
                            throw new Error("handler exploded");
                        },
                    } as any);
                },
            ],
        });

        await bus.start();
        assert.ok(capturedHandler, "subscribe should have captured the handler");

        // Deliver a raw event directly through the captured handler.
        // eventType must match method.input.typeName for routing to work.
        const rawEvent: RawEvent = {
            eventId: "evt-1",
            eventType: EventOptionsSchema.typeName,
            payload: new Uint8Array(),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        };

        await assert.rejects(
            () =>
                capturedHandler!(
                    rawEvent,
                    async () => {
                        ackCalls.push("ack");
                    },
                    async () => {
                        ackCalls.push("nack");
                    },
                ),
            { message: /handler exploded/ },
        );

        // Handler threw, so auto-ack should NOT have been called
        assert.equal(ackCalls.length, 0, "ack should not be called when handler throws");

        await bus.stop();
    });

    it("successful handler triggers auto-ack", async () => {
        let capturedHandler: RawEventHandler | null = null;
        const ackCalls: string[] = [];

        const trackingAdapter: EventAdapter = {
            name: "tracking",
            async connect() {},
            async disconnect() {},
            async publish() {},
            async subscribe(_patterns, handler): Promise<EventSubscription> {
                capturedHandler = handler;
                return { async unsubscribe() {} };
            },
        };

        const method = fakeDescMethod("okEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.OkService", [method]);

        let handlerCalled = false;

        const bus = createEventBus({
            adapter: trackingAdapter,
            routes: [
                (router) => {
                    router.service(service, {
                        okEvent: async () => {
                            handlerCalled = true;
                        },
                    } as any);
                },
            ],
        });

        await bus.start();
        assert.ok(capturedHandler, "subscribe should have captured the handler");
        const handler = capturedHandler as RawEventHandler;

        const rawEvent: RawEvent = {
            eventId: "evt-2",
            eventType: EventOptionsSchema.typeName,
            payload: new Uint8Array(),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        };

        await handler(
            rawEvent,
            async () => {
                ackCalls.push("ack");
            },
            async () => {
                ackCalls.push("nack");
            },
        );

        assert.equal(handlerCalled, true);
        // Handler succeeded without manual ack, so auto-ack should fire
        assert.deepEqual(ackCalls, ["ack"]);

        await bus.stop();
    });

    it("unmatched event type is auto-acked (skip)", async () => {
        let capturedHandler: RawEventHandler | null = null;
        const ackCalls: string[] = [];

        const trackingAdapter: EventAdapter = {
            name: "tracking",
            async connect() {},
            async disconnect() {},
            async publish() {},
            async subscribe(_patterns, handler): Promise<EventSubscription> {
                capturedHandler = handler;
                return { async unsubscribe() {} };
            },
        };

        const method = fakeDescMethod("myEvent", EventOptionsSchema.typeName, EventOptionsSchema);
        const service = fakeDescService("test.MyService", [method]);

        const bus = createEventBus({
            adapter: trackingAdapter,
            routes: [
                (router) => {
                    router.service(service, {
                        myEvent: async () => {},
                    } as any);
                },
            ],
        });

        await bus.start();
        assert.ok(capturedHandler, "subscribe should have captured the handler");
        const handler = capturedHandler as RawEventHandler;

        // Deliver an event with unmatched type
        const rawEvent: RawEvent = {
            eventId: "evt-3",
            eventType: "unknown.Event",
            payload: new Uint8Array(),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        };

        await handler(
            rawEvent,
            async () => {
                ackCalls.push("ack");
            },
            async () => {
                ackCalls.push("nack");
            },
        );

        // Unmatched events are acked to prevent redelivery
        assert.deepEqual(ackCalls, ["ack"]);

        await bus.stop();
    });
});
