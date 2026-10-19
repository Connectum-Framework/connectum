import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { NonRetryableError, RetryableError } from "../../src/errors.ts";
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

/**
 * Run `run` while recording the delay of every `setTimeout` the retry sleep
 * schedules, firing each timer immediately so the backoff schedule can be
 * observed without waiting for it.
 */
async function recordBackoffDelays(run: () => Promise<unknown>): Promise<number[]> {
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        return original(callback, 0);
    }) as unknown as typeof globalThis.setTimeout;
    try {
        await run();
    } finally {
        globalThis.setTimeout = original;
    }
    return delays;
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

        let calls = 0;
        const startTime = Date.now();
        await assert.rejects(() =>
            mw(makeRawEvent(), makeCtx(ac.signal), async () => {
                calls++;
                throw new Error("fail");
            }),
        );

        const elapsed = Date.now() - startTime;
        // Should abort quickly, NOT wait 5000ms for retry delay
        assert.ok(elapsed < 2000, `Expected abort within 2s, got ${elapsed}ms`);
        // The abort ends processing: the handler is not re-entered afterwards. An
        // abort that only woke the sleep and kept the retry loop running would
        // call the handler again.
        assert.equal(calls, 1, "no further attempts after the signal aborted");
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

    it("uses the documented defaults when none provided: 3 retries, exponential backoff from 1000ms, multiplier 2", async () => {
        let callCount = 0;
        const mw = retryMiddleware();

        const delays = await recordBackoffDelays(() =>
            assert.rejects(() =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    callCount++;
                    throw new Error("always fails");
                }),
            ),
        );

        // maxRetries 3 = 1 initial + 3 retries; delays 1000 * 2^(n-1)
        assert.equal(callCount, 4);
        assert.deepEqual(delays, [1000, 2000, 4000]);
    });

    it("caps the default exponential backoff at the documented maxDelay of 30000ms", async () => {
        const mw = retryMiddleware({ maxRetries: 6 });

        const delays = await recordBackoffDelays(() =>
            assert.rejects(() =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    throw new Error("always fails");
                }),
            ),
        );

        // 1000, 2000, 4000, 8000, 16000, then 32000 capped to 30000
        assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000]);
    });

    it("skips retry for NonRetryableError", async () => {
        let callCount = 0;
        const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 10 });

        await assert.rejects(
            () =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    callCount++;
                    throw new NonRetryableError("validation failed");
                }),
            { message: /validation failed/ },
        );

        // Should not retry -- only 1 call
        assert.equal(callCount, 1);
    });

    it("forces retry for RetryableError even when predicate rejects", async () => {
        let callCount = 0;
        const mw = retryMiddleware({
            maxRetries: 2,
            backoff: "fixed",
            initialDelay: 10,
            // Predicate rejects all errors
            retryableErrors: () => false,
        });

        await mw(makeRawEvent(), makeCtx(), async () => {
            callCount++;
            if (callCount < 3) throw new RetryableError("temporary failure");
        });

        // RetryableError overrides predicate: 1 initial + 2 retries = 3
        assert.equal(callCount, 3);
    });

    it("NonRetryableError takes priority over RetryableError brand", async () => {
        let callCount = 0;
        const mw = retryMiddleware({ maxRetries: 3, backoff: "fixed", initialDelay: 10 });

        // Create an error with both brands
        const NON_RETRYABLE = Symbol.for("@connectum/events.NonRetryableError");
        const RETRYABLE = Symbol.for("@connectum/events.RetryableError");
        const dualBranded = Object.assign(new Error("dual branded"), {
            [NON_RETRYABLE]: true,
            [RETRYABLE]: true,
        });

        await assert.rejects(
            () =>
                mw(makeRawEvent(), makeCtx(), async () => {
                    callCount++;
                    throw dualBranded;
                }),
            { message: /dual branded/ },
        );

        // NonRetryable wins -- only 1 call
        assert.equal(callCount, 1);
    });

    it("backward compat: retryableErrors predicate still works for plain errors", async () => {
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

        // Predicate rejects plain Error("fatal") -- only 1 call
        assert.equal(callCount, 1);
    });
});
