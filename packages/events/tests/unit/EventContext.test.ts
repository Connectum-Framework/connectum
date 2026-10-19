import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import type { RawEvent } from "../../src/types.ts";

function makeRawEvent(overrides?: Partial<RawEvent>): RawEvent {
    return {
        eventId: "test-id-1",
        eventType: "test.event",
        payload: new Uint8Array(),
        publishedAt: new Date("2026-01-01"),
        attempt: 1,
        metadata: new Map(),
        ...overrides,
    };
}

describe("createEventContext", () => {
    it("exposes raw event properties", () => {
        const publishedAt = new Date("2025-03-04T05:06:07.000Z");
        const metadata = new Map([["x-trace", "t-1"]]);
        const signal = new AbortController().signal;
        const raw = makeRawEvent({ eventId: "abc", attempt: 3, publishedAt, metadata });
        const ctx = createEventContext({
            raw,
            signal,
            onAck: async () => {},
            onNack: async () => {},
        });

        // Every documented property, each with a value distinct from any default.
        assert.equal(ctx.eventId, "abc");
        assert.equal(ctx.attempt, 3);
        assert.equal(ctx.eventType, "test.event");
        assert.equal(ctx.publishedAt.toISOString(), "2025-03-04T05:06:07.000Z");
        assert.equal(ctx.metadata.get("x-trace"), "t-1");
        assert.equal(ctx.metadata.size, 1);
        assert.equal(ctx.signal, signal);
    });

    it("ack is idempotent", async () => {
        let ackCount = 0;
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => {
                ackCount++;
            },
            onNack: async () => {},
        });

        await ctx.ack();
        await ctx.ack();
        assert.equal(ackCount, 1);
    });

    it("nack is idempotent", async () => {
        let nackCount = 0;
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => {},
            onNack: async () => {
                nackCount++;
            },
        });

        await ctx.nack();
        await ctx.nack();
        assert.equal(nackCount, 1);
    });

    it("ack prevents subsequent nack", async () => {
        let acked = false;
        let nacked = false;
        const ctx = createEventContext({
            raw: makeRawEvent(),
            signal: AbortSignal.timeout(1000),
            onAck: async () => {
                acked = true;
            },
            onNack: async () => {
                nacked = true;
            },
        });

        await ctx.ack();
        await ctx.nack();
        assert.equal(acked, true);
        assert.equal(nacked, false);
    });
});
