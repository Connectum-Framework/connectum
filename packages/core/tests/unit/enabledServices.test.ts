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
    it("matches with a middle wildcard", () => {
        assert.deepEqual(matchServicesPattern("acme.*.OrdersService", names), ["acme.v1.OrdersService"]);
    });
    it("treats a no-wildcard pattern as exact", () => {
        assert.deepEqual(matchServicesPattern("auth.v1.UsersService", names), ["auth.v1.UsersService"]);
        assert.deepEqual(matchServicesPattern("acme", names), []);
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
