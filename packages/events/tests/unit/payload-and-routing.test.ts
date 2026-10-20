/**
 * Payload serialization and one-handler-per-topic routing of the EventBus.
 *
 * The expected bytes are written out by hand from the protobuf wire format
 * (field 1, wire type 2: tag 0x0a, length, UTF-8 bytes), so the serializer is
 * not checked against its own output.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { EventOptionsSchema, event } from "#gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import type { EventAdapter, EventSubscription, PublishOptions, RawEvent, RawEventHandler } from "../../src/types.ts";

/** The wire encoding of `EventOptions { topic: text }`: tag 0x0a, length, UTF-8 bytes. */
function wireEncodedTopic(text: string): Uint8Array {
    const bytes = new TextEncoder().encode(text);
    assert.ok(bytes.length < 128, "the hand-written encoding supports a one-byte length only");
    return new Uint8Array([0x0a, bytes.length, ...bytes]);
}

// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
function fakeMethod(localName: string, topic?: string, inputTypeName?: string): any {
    const options = create(MethodOptionsSchema);
    if (topic !== undefined) {
        setExtension(options, event, create(EventOptionsSchema, { topic }));
    }
    // A distinct input type name gives the route its own message type; the
    // schema itself is the real one so that decoding works.
    const input =
        inputTypeName === undefined
            ? EventOptionsSchema
            : Object.create(EventOptionsSchema, { typeName: { value: inputTypeName, writable: false, enumerable: true } });
    return { localName, input, proto: { options: topic === undefined ? undefined : options } };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
function fakeService(typeName: string, methods: any[]): any {
    return { typeName, methods };
}

/** Adapter that records every call, so the lifecycle and the bytes on the wire are observable. */
function makeRecordingAdapter() {
    const calls: string[] = [];
    const published: Array<{ eventType: string; payload: Uint8Array; options?: PublishOptions }> = [];
    let handler: RawEventHandler | null = null;
    const adapter: EventAdapter = {
        name: "recording",
        connect: async () => {
            calls.push("connect");
        },
        disconnect: async () => {
            calls.push("disconnect");
        },
        publish: async (eventType, payload, options) => {
            published.push({ eventType, payload, ...(options ? { options } : {}) });
        },
        subscribe: async (patterns, subscribedHandler): Promise<EventSubscription> => {
            calls.push(`subscribe:${patterns.join(",")}`);
            handler = subscribedHandler;
            return {
                unsubscribe: async () => {
                    calls.push("unsubscribe");
                },
            };
        },
    };
    return { adapter, calls, published, deliver: (raw: RawEvent) => (handler as RawEventHandler)(raw, async () => undefined, async () => undefined) };
}

describe("EventBus payload serialization", () => {
    it("publishes the protobuf wire encoding of the message", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({ adapter: recording.adapter });
        await bus.start();

        await bus.publish(EventOptionsSchema, create(EventOptionsSchema, { topic: "orders.v1.created" }));
        await bus.stop();

        assert.equal(recording.published.length, 1);
        assert.deepEqual(
            [...(recording.published[0] as { payload: Uint8Array }).payload],
            [...wireEncodedTopic("orders.v1.created")],
            "the adapter receives the serialized message, not an empty buffer",
        );
    });

    it("decodes the wire payload into the message the handler receives", async () => {
        const recording = makeRecordingAdapter();
        const received: Array<string | undefined> = [];
        const bus = createEventBus({
            adapter: recording.adapter,
            routes: [
                (router) => {
                    router.service(fakeService("test.v1.PayloadService", [fakeMethod("onEvent")]), {
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                        onEvent: async (message: any) => {
                            received.push(message.topic);
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();

        await recording.deliver({
            eventId: "evt-1",
            eventType: EventOptionsSchema.typeName,
            payload: wireEncodedTopic("orders.v1.created"),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        });
        await bus.stop();

        assert.deepEqual(received, ["orders.v1.created"], "the handler gets the decoded fields of the payload, not an empty message");
    });

    it("carries a message with a field from publish to the handler end to end", async () => {
        const received: Array<string | undefined> = [];
        const bus = createEventBus({
            adapter: MemoryAdapter(),
            routes: [
                (router) => {
                    router.service(fakeService("test.v1.PayloadService", [fakeMethod("onEvent")]), {
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                        onEvent: async (message: any) => {
                            received.push(message.topic);
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();

        await bus.publish(EventOptionsSchema, create(EventOptionsSchema, { topic: "payments.v1.captured" }));
        await bus.stop();

        assert.deepEqual(received, ["payments.v1.captured"]);
    });
});

describe("EventBus one handler per topic", () => {
    it("rejects start() when two routes resolve to the same topic, naming the topic, and leaves nothing subscribed", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({
            adapter: recording.adapter,
            routes: [
                (router) => {
                    router.service(fakeService("test.v1.FirstService", [fakeMethod("first")]), {
                        first: async () => undefined,
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                    router.service(fakeService("test.v1.SecondService", [fakeMethod("second")]), {
                        second: async () => undefined,
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                },
            ],
        });

        await assert.rejects(() => bus.start(), new RegExp(`Duplicate event topic "${EventOptionsSchema.typeName.replaceAll(".", "\\.")}"`));

        assert.ok(!recording.calls.some((call) => call.startsWith("subscribe:")), "no subscription may be made for a rejected configuration");
        const connects = recording.calls.filter((call) => call === "connect").length;
        const disconnects = recording.calls.filter((call) => call === "disconnect").length;
        assert.equal(disconnects, connects, "a start() that failed must not leave the adapter connected");
    });

    it("accepts routes that resolve to distinct topics and subscribes to every one of them", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({
            adapter: recording.adapter,
            routes: [
                (router) => {
                    router.service(fakeService("test.v1.FirstService", [fakeMethod("first", "orders.v1.created")]), {
                        first: async () => undefined,
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                    router.service(fakeService("test.v1.SecondService", [fakeMethod("second", "orders.v1.cancelled", "test.v1.OrderCancelled")]), {
                        second: async () => undefined,
                        // biome-ignore lint/suspicious/noExplicitAny: handler map against a fake descriptor
                    } as any);
                },
            ],
        });

        await bus.start();
        await bus.stop();

        assert.ok(recording.calls.includes("subscribe:orders.v1.created,orders.v1.cancelled"), `one subscribe call carries both topics (calls: ${recording.calls.join(" | ")})`);
    });
});
