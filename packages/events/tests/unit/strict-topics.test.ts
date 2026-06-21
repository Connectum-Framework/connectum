/**
 * Tests for opt-in strict publish-topic resolution (`strictTopics`).
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EventOptionsSchema } from "../../gen/connectum/events/v1/options_pb.js";
import { createEventBus } from "../../src/EventBus.ts";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";

/** A minimal valid EventOptions message instance for publish(). */
const eventMsg = () => create(EventOptionsSchema, {});

describe("strictTopics", () => {
    let bus: ReturnType<typeof createEventBus> | null = null;

    afterEach(async () => {
        if (bus) {
            await bus.stop();
            bus = null;
        }
    });

    it("rejects a publish whose topic cannot be resolved when strictTopics is true", async () => {
        // No routes and no publishes cover EventOptions, so the topic would
        // otherwise silently fall back to the typeName.
        bus = createEventBus({ adapter: MemoryAdapter(), strictTopics: true });
        await bus.start();
        await assert.rejects(bus.publish(EventOptionsSchema, eventMsg()), /strictTopics/);
    });

    it("allows an explicit publishOptions.topic under strictTopics", async () => {
        bus = createEventBus({ adapter: MemoryAdapter(), strictTopics: true });
        await bus.start();
        await assert.doesNotReject(bus.publish(EventOptionsSchema, eventMsg(), { topic: "explicit.topic" }));
    });

    it("silently falls back to the typeName by default (strictTopics off)", async () => {
        bus = createEventBus({ adapter: MemoryAdapter() });
        await bus.start();
        await assert.doesNotReject(bus.publish(EventOptionsSchema, eventMsg()));
    });
});
