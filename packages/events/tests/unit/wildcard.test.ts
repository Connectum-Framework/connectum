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

    it("> in middle position does not match (non-terminal)", () => {
        // > is only valid as the LAST segment. When used in the middle,
        // it should not act as a multi-segment wildcard.
        assert.equal(matchPattern("orders.>.created", "orders.anything"), false);
        assert.equal(matchPattern("orders.>.created", "orders.anything.created"), false);
    });

    it("> at the end matches deeply nested topics", () => {
        assert.equal(matchPattern("app.>", "app.a.b.c.d"), true);
        assert.equal(matchPattern("app.>", "app.x"), true);
    });

    it("empty segments handled correctly", () => {
        assert.equal(matchPattern("a.b", "a.b"), true);
        assert.equal(matchPattern("a", "a"), true);
    });
});
