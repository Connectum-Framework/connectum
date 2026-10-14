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

    // The authorization guide's method-pattern table defines `*` as "all services and methods".
    // A skip list of `*` disables the check for everything, so the services used here differ.
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

    // In every list exactly one entry can match, and it sits at a different position each time,
    // so a matcher that only looks at the first, only the last, or skips the middle entry fails.
    for (const [kind, matching] of [
        ["exact method", "test.v1.UserService/GetUser"],
        ["service wildcard", "test.v1.UserService/*"],
        ["global wildcard", "*"],
    ] as const) {
        const misses = ["no.Match/Method", "another.Service/*"];
        for (const [position, patterns] of [
            ["first", [matching, ...misses]],
            ["middle", [misses[0], matching, misses[1]]],
            ["last", [...misses, matching]],
        ] as const) {
            it(`should match a ${kind} pattern at the ${position} position of the list`, () => {
                assert.strictEqual(matchesMethodPattern("test.v1.UserService", "GetUser", patterns), true);
            });
        }
    }

    // The guide lists only exact methods, `Service/*` and `*`; partial wildcards are unsupported.
    for (const pattern of ["test.v1.User*/GetUser", "test.v1.*/*", "test.v1.UserService/Get*", "test.v1.UserService/*Get"]) {
        it(`should not treat the partial wildcard ${pattern} as a match`, () => {
            assert.strictEqual(matchesMethodPattern("test.v1.UserService", "GetUser", [pattern]), false);
        });
    }

    it("should not match partial service name with service wildcard", () => {
        const result = matchesMethodPattern("test.v1.UserServiceExtended", "GetUser", ["test.v1.UserService/*"]);
        assert.strictEqual(result, false);
    });
});
