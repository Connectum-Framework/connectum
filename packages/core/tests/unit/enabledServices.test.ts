/**
 * enabledServices helpers unit tests — parseServicesEnv, matchServicesPattern,
 * mergeEnabledServices.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { matchServicesPattern, mergeEnabledServices, parseServicesEnv } from "../../src/enabledServices.ts";

describe("parseServicesEnv", () => {
    it("splits, trims, and drops empties", () => {
        assert.deepEqual(parseServicesEnv(" a.v1.S , b.v1.S ,, c.v1.S "), ["a.v1.S", "b.v1.S", "c.v1.S"]);
    });
    it("returns [] for undefined/empty", () => {
        assert.deepEqual(parseServicesEnv(undefined), []);
        assert.deepEqual(parseServicesEnv(""), []);
        assert.deepEqual(parseServicesEnv("   "), []);
    });
});

describe("matchServicesPattern", () => {
    const names = ["acme.v1.UsersService", "acme.v1.OrdersService", "auth.v1.UsersService"];
    it("matches a prefix glob across dots", () => {
        assert.deepEqual(matchServicesPattern("acme.*", names), ["acme.v1.UsersService", "acme.v1.OrdersService"]);
    });
    it("matches a suffix glob", () => {
        assert.deepEqual(matchServicesPattern("*.UsersService", names), ["acme.v1.UsersService", "auth.v1.UsersService"]);
    });
    it("matches with a wildcard in the middle of the pattern", () => {
        assert.deepEqual(matchServicesPattern("acme.*.OrdersService", names), ["acme.v1.OrdersService"]);
    });
    it("requires the text between two wildcards to be present", () => {
        // `*` is a wildcard in any position, so with two of them the literal
        // segment between them must still occur in the name.
        assert.deepEqual(matchServicesPattern("*.v1.*", names), names);
        assert.deepEqual(matchServicesPattern("*.v2.*", names), []);
        assert.deepEqual(matchServicesPattern("a*.v1.*Service", names), names);
        assert.deepEqual(matchServicesPattern("a*.v2.*Service", names), []);
    });
    it("keeps the literal text between wildcards in order", () => {
        assert.deepEqual(matchServicesPattern("acme.*Users*Service", names), ["acme.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme.*v1*Users*", names), ["acme.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme.*Users*v1*", names), []);
    });
    it("does not let the wildcard segments reuse the characters of the fixed ends", () => {
        // "ab" + any + "b" + any + "ba" needs at least five characters.
        assert.deepEqual(matchServicesPattern("ab*b*ba", ["abba", "abbba", "ababba"]), ["abbba", "ababba"]);
        // The fixed prefix and suffix cannot overlap either.
        assert.deepEqual(matchServicesPattern("acme.v1.UsersService*Service", ["acme.v1.UsersService"]), []);
        assert.deepEqual(matchServicesPattern("acme.v1.UsersService*Service", ["acme.v1.UsersServiceService"]), ["acme.v1.UsersServiceService"]);
    });
    it("lets a wildcard match the empty string and treats adjacent wildcards as one", () => {
        assert.deepEqual(matchServicesPattern("acme.v1.UsersService*", names), ["acme.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme**Service", names), ["acme.v1.UsersService", "acme.v1.OrdersService"]);
    });
    it("treats a no-wildcard pattern as exact", () => {
        assert.deepEqual(matchServicesPattern("auth.v1.UsersService", names), ["auth.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme", names), []);
    });
    it("treats every character except * literally, regular expression metacharacters included", () => {
        const odd = ["acmeXv1XUsersService", "acme.v1.UsersService", "acme.v1.(Users|Orders)Service", "a+b", "aab"];
        // `.` is not "any character".
        assert.deepEqual(matchServicesPattern("acme.v1.UsersService", odd), ["acme.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme.v1.*", odd), ["acme.v1.UsersService", "acme.v1.(Users|Orders)Service"]);
        // Alternation, groups, quantifiers and classes carry no meaning.
        assert.deepEqual(matchServicesPattern("acme.v1.(Users|Orders)Service", odd), ["acme.v1.(Users|Orders)Service"]);
        assert.deepEqual(matchServicesPattern("a+b", odd), ["a+b"]);
        assert.deepEqual(matchServicesPattern("a?b", odd), []);
        assert.deepEqual(matchServicesPattern("[a]*", odd), []);
        assert.deepEqual(matchServicesPattern("a+*", odd), ["a+b"]);
    });
    it("matches everything with a lone star", () => {
        assert.deepEqual(matchServicesPattern("*", names), names);
    });
});

describe("mergeEnabledServices", () => {
    it("de-duplicates preserving first-seen order", () => {
        assert.deepEqual(mergeEnabledServices(["a", "b"], ["b", "c"], ["a", "d"]), ["a", "b", "c", "d"]);
    });
    it("returns [] for no input", () => {
        assert.deepEqual(mergeEnabledServices(), []);
    });
});
