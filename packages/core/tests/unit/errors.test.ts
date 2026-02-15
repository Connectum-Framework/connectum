/**
 * Unit tests for SanitizableError protocol
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { isSanitizableError } from "../../src/errors.ts";

describe("isSanitizableError", () => {
    it("should return true for valid SanitizableError object", () => {
        const err = {
            clientMessage: "Access denied",
            serverDetails: { ruleName: "admin-only" },
            code: 7,
            message: "internal details",
        };
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

    it("should return false when clientMessage is not a string", () => {
        const err = {
            clientMessage: 42,
            serverDetails: {},
            code: 7,
        };
        assert.strictEqual(isSanitizableError(err), false);
    });

    it("should return false when serverDetails is null", () => {
        const err = {
            clientMessage: "msg",
            serverDetails: null,
            code: 7,
        };
        assert.strictEqual(isSanitizableError(err), false);
    });

    it("should return false when serverDetails is not an object", () => {
        const err = {
            clientMessage: "msg",
            serverDetails: "not an object",
            code: 7,
        };
        assert.strictEqual(isSanitizableError(err), false);
    });

    it("should return true even without code (code check is on type guard return)", () => {
        const err = {
            clientMessage: "msg",
            serverDetails: { key: "value" },
        };
        // isSanitizableError checks clientMessage + serverDetails
        // code is part of the type guard return type, not the check
        assert.strictEqual(isSanitizableError(err), true);
    });
});
