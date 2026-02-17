/**
 * Unit tests for method pattern matching utility
 *
 * Tests matchesMethodPattern() for exact match, wildcard,
 * service wildcard, no match, empty patterns, and multiple patterns.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { matchesMethodPattern } from "../../src/method-match.ts";

describe("matchesMethodPattern", () => {
    it("should match exact method pattern", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", ["test.v1.UserService/GetUser"]);
        assert.strictEqual(result, true);
    });

    it("should not match different exact method", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", ["test.v1.UserService/DeleteUser"]);
        assert.strictEqual(result, false);
    });

    it("should match wildcard '*' pattern for any method", () => {
        assert.strictEqual(matchesMethodPattern("any.Service", "AnyMethod", ["*"]), true);
        assert.strictEqual(matchesMethodPattern("another.Service", "Other", ["*"]), true);
    });

    it("should match service wildcard 'Service/*' for any method of that service", () => {
        assert.strictEqual(matchesMethodPattern("test.v1.UserService", "GetUser", ["test.v1.UserService/*"]), true);
        assert.strictEqual(matchesMethodPattern("test.v1.UserService", "DeleteUser", ["test.v1.UserService/*"]), true);
    });

    it("should not match service wildcard for different service", () => {
        const result = matchesMethodPattern("test.v1.OtherService", "GetUser", ["test.v1.UserService/*"]);
        assert.strictEqual(result, false);
    });

    it("should return false for empty patterns array", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", []);
        assert.strictEqual(result, false);
    });

    it("should return false when no pattern matches", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", [
            "other.Service/Method",
            "another.Service/*",
        ]);
        assert.strictEqual(result, false);
    });

    it("should match on first matching pattern in array", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", [
            "no.Match/Method",
            "test.v1.UserService/GetUser",
            "*",
        ]);
        assert.strictEqual(result, true);
    });

    it("should match when wildcard is among multiple patterns", () => {
        const result = matchesMethodPattern("test.v1.UserService", "GetUser", [
            "no.Match/Method",
            "*",
            "test.v1.UserService/GetUser",
        ]);
        assert.strictEqual(result, true);
    });

    it("should not match partial service name with service wildcard", () => {
        const result = matchesMethodPattern("test.v1.UserServiceExtended", "GetUser", ["test.v1.UserService/*"]);
        assert.strictEqual(result, false);
    });
});
