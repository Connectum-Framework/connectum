import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { dlqMiddleware } from "../../src/middleware/dlq.ts";
import type { EventAdapter, RawEvent } from "../../src/types.ts";

function makeRawEvent(overrides?: Partial<RawEvent>): RawEvent {
    return {
        eventId: "test-1",
        eventType: "test.event",
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
        ...overrides,
    };
}

function makeCtx(raw?: RawEvent) {
    const event = raw ?? makeRawEvent();
    let acked = false;
    let nacked = false;

    const ctx = createEventContext({
        raw: event,
        signal: AbortSignal.timeout(1000),
        onAck: async () => {
            acked = true;
        },
        onNack: async () => {
            nacked = true;
        },
    });

    return { ctx, isAcked: () => acked, isNacked: () => nacked };
}

describe("dlqMiddleware", () => {
    it("publishes failed events to DLQ topic and acks the original", async () => {
        const published: { eventType: string; payload: Uint8Array; metadata?: Record<string, string> }[] = [];
        const mockAdapter: Pick<EventAdapter, "publish"> = {
            async publish(eventType, payload, options) {
                published.push({ eventType, payload, ...(options?.metadata ? { metadata: options.metadata } : {}) });
            },
        };

        // Non-empty payload: with an empty one, publishing an empty payload instead of
        // the original would go unnoticed.
        const originalPayload = new Uint8Array([0x0a, 0x03, 0x66, 0x6f, 0x6f]);
        const event = makeRawEvent({ eventId: "evt-42", eventType: "orders.created", attempt: 2, payload: originalPayload });
        const { ctx, isAcked } = makeCtx(event);

        const mw = dlqMiddleware({ topic: "my-service.dlq" }, mockAdapter as EventAdapter);

        await mw(event, ctx, async () => {
            throw new Error("handler failed");
        });

        // Event was published to DLQ
        assert.equal(published.length, 1);
        assert.equal(published[0]!.eventType, "my-service.dlq");
        // The DLQ copy carries the original payload byte for byte
        assert.deepEqual(published[0]!.payload, originalPayload);
        assert.equal(published[0]!.metadata?.["dlq.original-topic"], "orders.created");
        assert.equal(published[0]!.metadata?.["dlq.original-id"], "evt-42");
        assert.equal(published[0]!.metadata?.["dlq.error"], "Error");
        assert.equal(published[0]!.metadata?.["dlq.attempt"], "2");

        // Original event was acked
        assert.equal(isAcked(), true);
    });

    it("does not publish to DLQ when handler succeeds", async () => {
        const published: string[] = [];
        const mockAdapter: Pick<EventAdapter, "publish"> = {
            async publish(eventType) {
                published.push(eventType);
            },
        };

        const event = makeRawEvent();
        const { ctx } = makeCtx(event);

        const mw = dlqMiddleware({ topic: "my-service.dlq" }, mockAdapter as EventAdapter);

        await mw(event, ctx, async () => {
            // Handler succeeds
        });

        assert.equal(published.length, 0);
    });

    it("rethrows when event is already from DLQ topic (self-loop prevention)", async () => {
        // The events middleware guide states that an event already on the configured DLQ
        // topic is rethrown instead of being published back to itself. That the original
        // is also left unacknowledged is Connectum's reading of "rethrown": the error
        // reaches the caller and the broker, not the middleware, settles the delivery.
        let publishCalled = false;
        const mockAdapter: Pick<EventAdapter, "publish"> = {
            async publish() {
                publishCalled = true;
            },
        };

        const dlqEvent = makeRawEvent({ eventType: "my-service.dlq" });
        const { ctx, isAcked } = makeCtx(dlqEvent);

        const mw = dlqMiddleware({ topic: "my-service.dlq" }, mockAdapter as EventAdapter);

        await assert.rejects(
            () =>
                mw(dlqEvent, ctx, async () => {
                    throw new Error("DLQ handler failed");
                }),
            { message: /DLQ handler failed/ },
        );

        // Should NOT publish to DLQ (would create infinite loop)
        assert.equal(publishCalled, false);
        // Should NOT ack (error propagates)
        assert.equal(isAcked(), false);
    });

    it("serializes a non-Error throwable as UnknownError in dlq.error", async () => {
        // The events middleware guide: the default `dlq.error` is the error name, or
        // `UnknownError` for a non-`Error` value.
        const published: { metadata?: Record<string, string> }[] = [];
        const mockAdapter: Pick<EventAdapter, "publish"> = {
            async publish(_eventType, _payload, options) {
                published.push({ ...(options?.metadata ? { metadata: options.metadata } : {}) });
            },
        };

        const event = makeRawEvent();
        const { ctx } = makeCtx(event);

        const mw = dlqMiddleware({ topic: "my-service.dlq" }, mockAdapter as EventAdapter);

        await mw(event, ctx, async () => {
            throw "string error";
        });

        assert.equal(published.length, 1);
        assert.equal(published[0]!.metadata?.["dlq.error"], "UnknownError");
    });

    it("uses custom errorSerializer when provided (N-8)", async () => {
        const published: { metadata?: Record<string, string> }[] = [];
        const mockAdapter: Pick<EventAdapter, "publish"> = {
            async publish(_eventType, _payload, options) {
                published.push({ ...(options?.metadata ? { metadata: options.metadata } : {}) });
            },
        };

        const event = makeRawEvent({ eventId: "evt-serial", eventType: "orders.created" });
        const { ctx } = makeCtx(event);

        const customSerializer = (error: unknown): string => {
            if (error instanceof Error) {
                return `CUSTOM:${error.name}:${error.message}`;
            }
            return `CUSTOM:${String(error)}`;
        };

        const mw = dlqMiddleware({ topic: "my-service.dlq", errorSerializer: customSerializer }, mockAdapter as EventAdapter);

        const testError = new TypeError("invalid input");
        await mw(event, ctx, async () => {
            throw testError;
        });

        assert.equal(published.length, 1);
        assert.equal(published[0]!.metadata?.["dlq.error"], "CUSTOM:TypeError:invalid input");
        assert.equal(published[0]!.metadata?.["dlq.original-id"], "evt-serial");
    });
});
