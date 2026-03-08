import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { retryMiddleware } from "../../src/middleware/retry.ts";
import type { RawEvent } from "../../src/types.ts";

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

function makeCtx(signal?: AbortSignal) {
    return createEventContext({
        raw: makeRawEvent(),
        signal: signal ?? AbortSignal.timeout(5000),
        onAck: async () => {},
        onNack: async () => {},
    });
}

describe("retryMiddleware", () => {
    it("retries on failure up to maxRetries", async () => {
        let callCount = 0;
        const mw = retryMiddleware({ maxRetries: 2, backoff: "fixed", initialDelay: 10 });

        const event = makeRawEvent();
        await mw(event, makeCtx(), async () => {
            callCount++;
            if (callCount < 3) throw new Error("fail");
        });

        // 1 initial + 2 retries = 3 total calls
        assert.equal(callCount, 3);
    });

    it("throws after all retries exhausted", async () => {
        const mw = retryMiddleware({ maxRetries: 1, backoff: "fixed", initialDelay: 10 });

        await assert.rejects(
            () =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    throw new Error("persistent failure");
                }),
            { message: /persistent failure/ },
        );
    });

    it("propagates attempt number to event on retries", async () => {
        const attempts: number[] = [];
        const mw = retryMiddleware({ maxRetries: 2, backoff: "fixed", initialDelay: 10 });

        const event = makeRawEvent({ attempt: 1 });
        let callCount = 0;

        // next() receives an optional updatedEvent from retry middleware (C-1).
        // We capture the attempt from the updatedEvent when provided,
        // falling back to the original event for the first call.
        await mw(event, makeCtx(), async (updatedEvent) => {
            const currentEvent = updatedEvent ?? event;
            attempts.push(currentEvent.attempt);
            callCount++;
            if (callCount < 3) throw new Error("fail");
        });

        // Original event is NOT mutated (readonly contract preserved)
        assert.equal(event.attempt, 1);

        assert.equal(attempts[0], 1); // First attempt
        assert.equal(attempts[1], 2); // Second attempt (retry 1)
        assert.equal(attempts[2], 3); // Third attempt (retry 2)
    });

    it("respects abort signal during retry", async () => {
        const ac = new AbortController();
        const mw = retryMiddleware({ maxRetries: 5, backoff: "fixed", initialDelay: 5000 });

        // Abort after 50ms
        const timer = globalThis.setTimeout(() => ac.abort(), 50);

        const startTime = Date.now();
        await assert.rejects(() => mw(makeRawEvent(), makeCtx(ac.signal), async () => {
            throw new Error("fail");
        }));

        const elapsed = Date.now() - startTime;
        // Should abort quickly, NOT wait 5000ms for retry delay
        assert.ok(elapsed < 2000, `Expected abort within 2s, got ${elapsed}ms`);
        globalThis.clearTimeout(timer);
    });

    it("skips retry for non-retryable errors", async () => {
        let callCount = 0;
        const mw = retryMiddleware({
            maxRetries: 3,
            backoff: "fixed",
            initialDelay: 10,
            retryableErrors: (err) => err instanceof Error && err.message !== "fatal",
        });

        await assert.rejects(
            () =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    callCount++;
                    throw new Error("fatal");
                }),
            { message: /fatal/ },
        );

        // Should not retry -- only 1 call
        assert.equal(callCount, 1);
    });

    it("retries retryable errors but not non-retryable", async () => {
        let callCount = 0;
        const mw = retryMiddleware({
            maxRetries: 3,
            backoff: "fixed",
            initialDelay: 10,
            retryableErrors: (err) => err instanceof Error && err.message === "transient",
        });

        // First 2 calls throw retryable, third throws non-retryable
        await assert.rejects(
            () =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    callCount++;
                    if (callCount <= 2) throw new Error("transient");
                    throw new Error("fatal");
                }),
            { message: /fatal/ },
        );

        assert.equal(callCount, 3);
    });

    it("succeeds without retries when handler passes", async () => {
        let callCount = 0;
        const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 10 });

        await mw(makeRawEvent(), makeCtx(), async () => {
            callCount++;
        });

        assert.equal(callCount, 1);
    });

    it("uses default options when none provided", async () => {
        let callCount = 0;
        const mw = retryMiddleware();

        // Handler succeeds on first try -- defaults should not interfere
        await mw(makeRawEvent(), makeCtx(), async () => {
            callCount++;
        });

        assert.equal(callCount, 1);
    });
});
