/**
 * Minimal reproduction test: retry middleware through composeMiddleware.
 *
 * When retry middleware is invoked directly (unit test), next() is just a
 * callback and works fine. But when composed via composeMiddleware, the
 * dispatch() guard `if (i <= index)` prevents re-entry because the index
 * is already advanced to the handler position after the first call.
 *
 * The catch block in composeMiddleware (line 63) resets `index = i - 1`,
 * but the question is whether this actually works correctly for retry.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { retryMiddleware } from "../../src/middleware/retry.ts";
import { composeMiddleware } from "../../src/middleware.ts";
import type { EventMiddleware, RawEvent } from "../../src/types.ts";

function makeRawEvent(): RawEvent {
    return {
        eventId: "test-1",
        eventType: "test.event",
        payload: new Uint8Array(),
        publishedAt: new Date(),
        attempt: 1,
        metadata: new Map(),
    };
}

function makeCtx() {
    return createEventContext({
        raw: makeRawEvent(),
        signal: AbortSignal.timeout(5000),
        onAck: async () => {},
        onNack: async () => {},
    });
}

describe("retry through composeMiddleware (bug reproduction)", () => {
    it("retry middleware alone: handler called 3 times (1 + 2 retries)", async () => {
        let callCount = 0;
        const mw = retryMiddleware({ maxRetries: 2, backoff: "fixed", initialDelay: 10 });

        // Direct call — works fine, next is just a callback
        await mw(makeRawEvent(), makeCtx(), async () => {
            callCount++;
            if (callCount < 3) throw new Error("fail");
        });

        assert.equal(callCount, 3, "direct call: handler should be called 3 times");
    });

    it("retry middleware through composeMiddleware: handler should be called 3 times", async () => {
        let callCount = 0;
        const retry = retryMiddleware({ maxRetries: 2, backoff: "fixed", initialDelay: 10 });

        // Through composeMiddleware — the bug scenario
        const composed = composeMiddleware([retry], async () => {
            callCount++;
            if (callCount < 3) throw new Error("fail");
        });

        await composed(makeRawEvent(), makeCtx());

        assert.equal(callCount, 3, "composed: handler should be called 3 times (1 original + 2 retries)");
    });

    it("DLQ + retry through composeMiddleware: retry exhausted then DLQ catches", async () => {
        let handlerCallCount = 0;
        let dlqCaught = false;

        const fakeDlq: EventMiddleware = async (_event, _ctx, next) => {
            try {
                await next();
            } catch {
                dlqCaught = true;
                // DLQ swallows error after publishing to DLQ topic
            }
        };

        const retry = retryMiddleware({ maxRetries: 2, backoff: "fixed", initialDelay: 10 });

        // Order: [dlq, retry] — dlq is outermost, retry is innermost
        // This matches EventBus.ts line 102-109
        const composed = composeMiddleware([fakeDlq, retry], async () => {
            handlerCallCount++;
            throw new Error("always fails");
        });

        await composed(makeRawEvent(), makeCtx());

        assert.equal(handlerCallCount, 3, "handler should be called 3 times (1 + 2 retries) before DLQ catches");
        assert.equal(dlqCaught, true, "DLQ should have caught the exhausted error");
    });
});
