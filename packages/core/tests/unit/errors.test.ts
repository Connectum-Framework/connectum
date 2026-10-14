/**
 * Unit tests for SanitizableError protocol
 *
 * The documented contract: the guard accepts an Error instance that carries a
 * string `clientMessage`, a non-null object `serverDetails` and a numeric
 * `code`; a plain object with the same fields does not satisfy it. Every
 * rejection case below starts from an Error that satisfies the whole contract
 * and breaks exactly one property, so each case fails only through its own check.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { isSanitizableError } from "../../src/errors.ts";

/** An Error that satisfies the whole contract, with selected properties overridden. */
function sanitizable(overrides: Record<string, unknown> = {}): Error {
    return Object.assign(new Error("internal details"), { clientMessage: "Access denied", serverDetails: { ruleName: "admin-only" }, code: 7 }, overrides);
}

/** The contract-satisfying Error with one property removed. */
function without(property: string): Error {
    const err = sanitizable();
    delete (err as unknown as Record<string, unknown>)[property];
    return err;
}

describe("isSanitizableError", () => {
    it("should return true for a real Error with SanitizableError properties", () => {
        assert.strictEqual(isSanitizableError(sanitizable()), true);
    });

    it("should accept an Error subclass instance", () => {
        class DeniedError extends Error {}
        const err = Object.assign(new DeniedError("x"), { clientMessage: "Access denied", serverDetails: {}, code: 7 });
        assert.strictEqual(isSanitizableError(err), true);
    });

    it("should return false for null", () => {
        assert.strictEqual(isSanitizableError(null), false);
    });

    it("should return false for undefined", () => {
        assert.strictEqual(isSanitizableError(undefined), false);
    });

    it("should return false for plain string", () => {
        assert.strictEqual(isSanitizableError("error string"), false);
    });

    it("should return false for plain Error", () => {
        assert.strictEqual(isSanitizableError(new Error("plain")), false);
    });

    it("should return false for a plain object that carries every property but is not an Error", () => {
        assert.strictEqual(isSanitizableError({ clientMessage: "Access denied", serverDetails: {}, code: 7 }), false);
    });

    it("should return false when clientMessage is not a string", () => {
        assert.strictEqual(isSanitizableError(sanitizable({ clientMessage: 42 })), false);
    });

    it("should return false when clientMessage is missing", () => {
        assert.strictEqual(isSanitizableError(without("clientMessage")), false);
    });

    it("should return false when serverDetails is null", () => {
        assert.strictEqual(isSanitizableError(sanitizable({ serverDetails: null })), false);
    });

    it("should return false when serverDetails is not an object", () => {
        assert.strictEqual(isSanitizableError(sanitizable({ serverDetails: "not an object" })), false);
    });

    it("should return false when serverDetails is missing", () => {
        assert.strictEqual(isSanitizableError(without("serverDetails")), false);
    });

    it("should return false without numeric code", () => {
        assert.strictEqual(isSanitizableError(without("code")), false);
    });

    it("should return false when code is not a number", () => {
        assert.strictEqual(isSanitizableError(sanitizable({ code: "not-a-number" })), false);
    });
});
