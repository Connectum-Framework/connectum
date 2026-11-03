/**
 * `publish` accepts the init shape of a message, not only a fully built message.
 *
 * Two layers. The compile-time layer is this file itself: `pnpm typecheck` includes `tests/`, and
 * every call below passes a plain object literal, which `MessageShape` refused with TS2345 (no
 * `$typeName`) while the runtime already built the message with `create(schema, data)`. The
 * runtime layer decodes the bytes the adapter received with `fromBinary` and compares them with
 * the input, so a path that forwarded the raw object without `create` would fail here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { DescriptorProtoSchema, ListValueSchema, ValueSchema } from "@bufbuild/protobuf/wkt";
import { createEventBus } from "../../src/EventBus.ts";
import type { EventAdapter, EventBus, EventContext, PublishOptions, RawEvent, RawEventHandler } from "../../src/types.ts";

// biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
const fakeService = {
    typeName: "test.v1.RelayService",
    methods: [{ localName: "relay", input: DescriptorProtoSchema, proto: { options: undefined } }],
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
} as any;

/** Adapter that keeps the bytes of every publish and can replay one to the subscribed handler. */
function makeRecordingAdapter() {
    const published: Array<{ eventType: string; payload: Uint8Array }> = [];
    let handler: RawEventHandler | null = null;
    const adapter: EventAdapter = {
        name: "recording",
        connect: async () => undefined,
        disconnect: async () => undefined,
        publish: async (eventType: string, payload: Uint8Array, _options?: PublishOptions) => {
            published.push({ eventType, payload });
        },
        subscribe: async (_patterns, subscribedHandler) => {
            handler = subscribedHandler;
            return { unsubscribe: async () => undefined };
        },
    };
    return { adapter, published, deliver: (raw: RawEvent) => (handler as RawEventHandler)(raw, async () => undefined, async () => undefined) };
}

describe("publish with an init shape", () => {
    it("publishes a plain object", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({ adapter: recording.adapter });
        await bus.start();

        await bus.publish(DescriptorProtoSchema, { name: "Order" });

        const decoded = fromBinary(DescriptorProtoSchema, recording.published[0]?.payload as Uint8Array);
        assert.equal(decoded.name, "Order");
        await bus.stop();
    });

    it("publishes a plain object with nested messages, a repeated field and a oneof", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({ adapter: recording.adapter });
        await bus.start();

        await bus.publish(DescriptorProtoSchema, {
            name: "Order",
            // repeated field of nested messages, each given as a plain object
            field: [{ name: "id", number: 1 }, { name: "amount", number: 2 }],
            // singular nested message as a plain object
            options: { deprecated: true },
        });
        await bus.publish(ListValueSchema, {
            // repeated nested messages whose own oneof is set through `{ case, value }`
            values: [{ kind: { case: "stringValue", value: "a" } }, { kind: { case: "numberValue", value: 2 } }],
        });
        await bus.stop();

        const order = fromBinary(DescriptorProtoSchema, recording.published[0]?.payload as Uint8Array);
        assert.deepEqual(
            order.field.map((f) => [f.name, f.number]),
            [
                ["id", 1],
                ["amount", 2],
            ],
        );
        assert.equal(order.options?.deprecated, true);

        const list = fromBinary(ListValueSchema, recording.published[1]?.payload as Uint8Array);
        assert.deepEqual(
            list.values.map((v) => v.kind),
            [
                { case: "stringValue", value: "a" },
                { case: "numberValue", value: 2 },
            ],
        );
    });

    it("still publishes a fully built message and yields the same bytes as the plain object", async () => {
        const recording = makeRecordingAdapter();
        const bus = createEventBus({ adapter: recording.adapter });
        await bus.start();

        await bus.publish(ValueSchema, create(ValueSchema, { kind: { case: "stringValue", value: "x" } }));
        await bus.publish(ValueSchema, { kind: { case: "stringValue", value: "x" } });
        await bus.stop();

        assert.deepEqual(recording.published[0]?.payload, recording.published[1]?.payload);
        const decoded = fromBinary(ValueSchema, recording.published[0]?.payload as Uint8Array);
        assert.deepEqual(decoded.kind, { case: "stringValue", value: "x" });
    });

    it("accepts a plain object through ctx.publish", async () => {
        const recording = makeRecordingAdapter();
        let captured: EventContext | undefined;
        const bus: EventBus = createEventBus({
            adapter: recording.adapter,
            routes: [
                (router) => {
                    router.service(fakeService, {
                        relay: async (_event: unknown, ctx: EventContext) => {
                            captured = ctx;
                            await ctx.publish(DescriptorProtoSchema, { name: "Relayed", field: [{ name: "id", number: 1 }] });
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });
        await bus.start();

        await recording.deliver({
            eventId: "evt-1",
            eventType: DescriptorProtoSchema.typeName,
            payload: new Uint8Array(),
            publishedAt: new Date(),
            attempt: 1,
            metadata: new Map(),
        });
        await bus.stop();

        assert.ok(captured);
        const relayed = fromBinary(DescriptorProtoSchema, recording.published[0]?.payload as Uint8Array);
        assert.equal(relayed.name, "Relayed");
        assert.equal(relayed.field[0]?.name, "id");
    });
});
