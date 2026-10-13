/**
 * Unit tests for topic name resolution (topic.ts)
 *
 * Tests resolveTopicName() which resolves event topics from proto method
 * descriptors, prioritizing custom (event).topic option over input typeName.
 *
 * Uses real @bufbuild/protobuf create/setExtension to build valid proto
 * descriptors with method options, avoiding mock.module() and experimental flags.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DescMethod } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { EventOptionsSchema, event } from "#gen/connectum/events/v1/options_pb.js";
import { resolveTopicName } from "../../src/topic.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake DescMethod without any custom event option.
 * `proto.options` is undefined so hasOption() returns false.
 */
function fakeMethodNoOption(inputTypeName: string): DescMethod {
    return {
        kind: "rpc",
        name: "HandleEvent",
        localName: "handleEvent",
        input: { typeName: inputTypeName },
        output: { typeName: "google.protobuf.Empty" },
        proto: { options: undefined },
    } as unknown as DescMethod;
}

/**
 * Create a fake DescMethod with the (event).topic option set.
 * Uses real proto create + setExtension to produce valid MethodOptions
 * with the extension encoded in $unknown fields.
 */
function fakeMethodWithTopic(inputTypeName: string, topic: string): DescMethod {
    const methodOptions = create(MethodOptionsSchema);
    const eventOptions = create(EventOptionsSchema, { topic });
    setExtension(methodOptions, event, eventOptions);

    return {
        kind: "rpc",
        name: "HandleEvent",
        localName: "handleEvent",
        input: { typeName: inputTypeName },
        output: { typeName: "google.protobuf.Empty" },
        proto: { options: methodOptions },
    } as unknown as DescMethod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveTopicName()", () => {
    it("should return method.input.typeName when no custom option is set", () => {
        const method = fakeMethodNoOption("order.v1.OrderCreated");
        const topic = resolveTopicName(method);

        assert.equal(topic, "order.v1.OrderCreated");
    });

    it("should return custom topic string when proto option is set", () => {
        const method = fakeMethodWithTopic("order.v1.OrderCreated", "custom.topic.name");
        const topic = resolveTopicName(method);

        assert.equal(topic, "custom.topic.name");
    });

    it("should return input.typeName when the event option is present but its topic field is not set", () => {
        // options.proto: "When not set, the topic defaults to the input message's typeName."
        const methodOptions = create(MethodOptionsSchema);
        setExtension(methodOptions, event, create(EventOptionsSchema));
        const method = {
            kind: "rpc",
            name: "HandleEvent",
            localName: "handleEvent",
            input: { typeName: "payment.v1.PaymentProcessed" },
            output: { typeName: "google.protobuf.Empty" },
            proto: { options: methodOptions },
        } as unknown as DescMethod;

        assert.equal(resolveTopicName(method), "payment.v1.PaymentProcessed");
    });

    it("should treat an explicitly set empty topic as unset (Connectum decision, no documented source)", () => {
        // options.proto only says what happens "when not set". In proto2 an empty string
        // is a set value, so whether it means "no override" is not documented. Connectum
        // chose to treat "" as no override and fall back to input.typeName.
        const method = fakeMethodWithTopic("payment.v1.PaymentProcessed", "");
        const topic = resolveTopicName(method);

        assert.equal(topic, "payment.v1.PaymentProcessed");
    });
});
