import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparePatterns, matchesPattern, ownedPattern, ownerOf, runsHandler } from "../../src/patternOwner.ts";

describe("matchesPattern", () => {
    it("follows NATS wildcard rules", () => {
        assert.equal(matchesPattern("user.*", "user.created"), true);
        assert.equal(matchesPattern("user.*", "user.created.v2"), false);
        assert.equal(matchesPattern("user.>", "user"), false);
        assert.equal(matchesPattern("user.>", "user.created.v2"), true);
        assert.equal(matchesPattern("a.*.c", "a.b.c"), true);
        assert.equal(matchesPattern("a.*.c", "a.b.d"), false);
        assert.equal(matchesPattern("a.b", "a.b"), true);
        assert.equal(matchesPattern("a.b", "a.b.c"), false);
        assert.equal(matchesPattern(">", "a"), true);
    });
});

describe("comparePatterns", () => {
    it("puts the more specific pattern first: literal, then `*`, then `>`; longer before shorter; then text", () => {
        const sorted = ["user.>", "user.*", "user.created", ">", "*.*", "a.b.c", "user.*.x"].sort(comparePatterns);
        assert.deepEqual(sorted, ["a.b.c", "user.created", "user.*.x", "user.*", "*.*", "user.>", ">"]);
    });

    it("is a total order: antisymmetric, transitive over a sample, and zero only for equal text", () => {
        const sample = ["a", "a.b", "a.*", "a.>", "*.b", "*", ">", "b.a", "a.*.c", "a.b.*", "a.b.c"];
        for (const x of sample) {
            for (const y of sample) {
                assert.equal(Math.sign(comparePatterns(x, y)) + Math.sign(comparePatterns(y, x)), 0);
                assert.equal(comparePatterns(x, y) === 0, x === y);
                for (const z of sample) {
                    if (comparePatterns(x, y) < 0 && comparePatterns(y, z) < 0) {
                        assert.ok(comparePatterns(x, z) < 0, `${x} < ${y} < ${z}`);
                    }
                }
            }
        }
    });
});

describe("ownerOf", () => {
    const owned = [
        ownedPattern("user.created", 100),
        ownedPattern("user.*", 50),
        ownedPattern("user.>", 1),
    ];

    it("picks the most specific pattern whose consumer delivers the sequence", () => {
        assert.equal(ownerOf(owned, "user.created", 150), "user.created");
        assert.equal(ownerOf(owned, "user.created", 99), "user.*");
        assert.equal(ownerOf(owned, "user.created", 49), "user.>");
        assert.equal(ownerOf(owned, "user.updated", 150), "user.*");
        assert.equal(ownerOf(owned, "user.profile.changed", 150), "user.>");
    });

    it("returns undefined when nothing matches", () => {
        assert.equal(ownerOf(owned, "order.created", 150), undefined);
    });

    it("decides partial overlaps by the same order on every replica", () => {
        const partial = [
            ownedPattern("a.*.c", 1),
            ownedPattern("a.b.*", 1),
        ].sort((x, y) => comparePatterns(x.pattern, y.pattern));
        assert.equal(ownerOf(partial, "a.b.c", 10), "a.*.c");
        assert.equal(ownerOf(partial, "a.b.x", 10), "a.b.*");
        assert.equal(ownerOf(partial, "a.x.c", 10), "a.*.c");
    });
});

describe("runsHandler", () => {
    const owned = [ownedPattern("user.created", 100), ownedPattern("user.>", 10)];
    const [narrow, wide] = owned as [typeof owned[0], typeof owned[1]];

    it("runs the handler for the delivery of the owning pattern only", () => {
        assert.equal(runsHandler(owned, narrow, "user.created", 150), true);
        assert.equal(runsHandler(owned, wide, "user.created", 150), false);
        assert.equal(runsHandler(owned, wide, "user.updated", 150), true);
    });

    it("leaves a message below the narrow consumer's bound to the wide consumer", () => {
        assert.equal(runsHandler(owned, wide, "user.created", 50), true);
    });

    it("always runs the handler for a delivery below the delivering consumer's own bound", () => {
        // The narrow consumer delivers sequence 50 after all: its bound was computed above an unacknowledged message.
        assert.equal(runsHandler(owned, narrow, "user.created", 50), true);
        // The same holds when no pattern claims the sequence at all.
        const late = [ownedPattern("user.created", 100), ownedPattern("user.>", 200)];
        assert.equal(runsHandler(late, late[0] as typeof narrow, "user.created", 50), true);
    });
});
