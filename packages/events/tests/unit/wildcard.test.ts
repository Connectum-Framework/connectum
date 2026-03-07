import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchPattern } from "../../src/wildcard.ts";

describe("matchPattern", () => {
    it("matches exact topic", () => {
        assert.equal(matchPattern("user.created", "user.created"), true);
    });

    it("rejects different topic", () => {
        assert.equal(matchPattern("user.created", "user.updated"), false);
    });

    it("* matches single segment", () => {
        assert.equal(matchPattern("user.*", "user.created"), true);
    });

    it("* does not match multiple segments", () => {
        assert.equal(matchPattern("user.*", "user.created.v2"), false);
    });

    it("> matches one segment", () => {
        assert.equal(matchPattern("user.>", "user.created"), true);
    });

    it("> matches multiple segments", () => {
        assert.equal(matchPattern("user.>", "user.created.v2"), true);
    });

    it("> requires at least one segment", () => {
        assert.equal(matchPattern("user.>", "user"), false);
    });

    it("matches pattern with no wildcards exactly", () => {
        assert.equal(matchPattern("a.b.c", "a.b.c"), true);
        assert.equal(matchPattern("a.b.c", "a.b.d"), false);
    });

    it("* in middle position", () => {
        assert.equal(matchPattern("a.*.c", "a.b.c"), true);
        assert.equal(matchPattern("a.*.c", "a.x.c"), true);
        assert.equal(matchPattern("a.*.c", "a.b.d"), false);
    });
});
