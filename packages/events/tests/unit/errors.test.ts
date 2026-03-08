import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NonRetryableError, RetryableError } from "../../src/errors.ts";

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

    it("has correct name property", () => {
        const error = new NonRetryableError("test");
        assert.equal(error.name, "NonRetryableError");
    });

    it("preserves cause via ErrorOptions", () => {
        const cause = new Error("root cause");
        const error = new NonRetryableError("wrapper", { cause });
        assert.equal(error.cause, cause);
    });

    it("is instanceof Error", () => {
        const error = new NonRetryableError("test");
        assert.ok(error instanceof Error);
        assert.ok(error instanceof NonRetryableError);
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

    it("has correct name property", () => {
        const error = new RetryableError("test");
        assert.equal(error.name, "RetryableError");
    });

    it("preserves cause via ErrorOptions", () => {
        const cause = new Error("root cause");
        const error = new RetryableError("wrapper", { cause });
        assert.equal(error.cause, cause);
    });

    it("is instanceof Error", () => {
        const error = new RetryableError("test");
        assert.ok(error instanceof Error);
        assert.ok(error instanceof RetryableError);
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

    it("error with both brands is detected by both guards", () => {
        const NON_RETRYABLE = Symbol.for("@connectum/events.NonRetryableError");
        const RETRYABLE = Symbol.for("@connectum/events.RetryableError");
        const dualBranded = Object.assign(new Error("dual"), {
            [NON_RETRYABLE]: true,
            [RETRYABLE]: true,
        });
        // Both type guards detect their respective brand
        assert.equal(NonRetryableError.isNonRetryable(dualBranded), true);
        assert.equal(RetryableError.isRetryable(dualBranded), true);
    });
});
