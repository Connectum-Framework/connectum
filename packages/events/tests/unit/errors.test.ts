import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventContext } from "../../src/EventContext.ts";
import { NonRetryableError, RetryableError } from "../../src/errors.ts";
import { dlqMiddleware } from "../../src/middleware/dlq.ts";
import type { EventAdapter } from "../../src/types.ts";

/**
 * Run a failing handler through the DLQ middleware with its default serializer and
 * return the `dlq.error` label it wrote. The middleware guide says the default is the
 * error name for an `Error` and `UnknownError` for any other thrown value.
 */
async function deadLetterErrorLabel(thrown: unknown): Promise<string | undefined> {
    let label: string | undefined;
    const adapter = {
        async publish(_topic: string, _payload: Uint8Array, options?: { metadata?: Record<string, string> }) {
            label = options?.metadata?.["dlq.error"];
        },
    } as unknown as EventAdapter;
    const raw = { eventId: "e1", eventType: "t", payload: new Uint8Array(), publishedAt: new Date(), attempt: 1, metadata: new Map<string, string>() };
    const ctx = createEventContext({ raw, signal: AbortSignal.timeout(1000), onAck: async () => {}, onNack: async () => {} });
    await dlqMiddleware({ topic: "t.dlq" }, adapter)(raw, ctx, async () => {
        throw thrown;
    });
    return label;
}

describe("NonRetryableError", () => {
    it("isNonRetryable returns true for NonRetryableError instances", () => {
        const error = new NonRetryableError("validation failed");
        assert.equal(NonRetryableError.isNonRetryable(error), true);
    });

    it("isNonRetryable returns false for plain Error", () => {
        const error = new Error("plain error");
        assert.equal(NonRetryableError.isNonRetryable(error), false);
    });

    it("isNonRetryable returns false for null and undefined", () => {
        assert.equal(NonRetryableError.isNonRetryable(null), false);
        assert.equal(NonRetryableError.isNonRetryable(undefined), false);
    });

    it("is reported by its class name in dlq.error (a real Error, not an unknown throwable)", async () => {
        assert.equal(await deadLetterErrorLabel(new NonRetryableError("test")), "NonRetryableError");
    });

    it("preserves cause via ErrorOptions", () => {
        const cause = new Error("root cause");
        const error = new NonRetryableError("wrapper", { cause });
        assert.equal(error.cause, cause);
    });
});

describe("RetryableError", () => {
    it("isRetryable returns true for RetryableError instances", () => {
        const error = new RetryableError("connection lost");
        assert.equal(RetryableError.isRetryable(error), true);
    });

    it("isRetryable returns false for plain Error", () => {
        const error = new Error("plain error");
        assert.equal(RetryableError.isRetryable(error), false);
    });

    it("isRetryable returns false for null and undefined", () => {
        assert.equal(RetryableError.isRetryable(null), false);
        assert.equal(RetryableError.isRetryable(undefined), false);
    });

    it("is reported by its class name in dlq.error (a real Error, not an unknown throwable)", async () => {
        assert.equal(await deadLetterErrorLabel(new RetryableError("test")), "RetryableError");
    });

    it("preserves cause via ErrorOptions", () => {
        const cause = new Error("root cause");
        const error = new RetryableError("wrapper", { cause });
        assert.equal(error.cause, cause);
    });
});

describe("Cross-realm compatibility", () => {
    it("Symbol.for brand works with manual branding", () => {
        // Simulate cross-realm: manually create an object with the brand symbol
        const NON_RETRYABLE = Symbol.for("@connectum/events.NonRetryableError");
        const fakeError = Object.assign(new Error("cross-realm"), {
            [NON_RETRYABLE]: true,
        });
        assert.equal(NonRetryableError.isNonRetryable(fakeError), true);
    });

    it("Symbol.for brand works for RetryableError with manual branding", () => {
        const RETRYABLE = Symbol.for("@connectum/events.RetryableError");
        const fakeError = Object.assign(new Error("cross-realm"), {
            [RETRYABLE]: true,
        });
        assert.equal(RetryableError.isRetryable(fakeError), true);
    });
});

describe("Brand interaction", () => {
    it("NonRetryableError is not detected as retryable", () => {
        const error = new NonRetryableError("test");
        assert.equal(RetryableError.isRetryable(error), false);
    });

    it("RetryableError is not detected as non-retryable", () => {
        const error = new RetryableError("test");
        assert.equal(NonRetryableError.isNonRetryable(error), false);
    });
});
