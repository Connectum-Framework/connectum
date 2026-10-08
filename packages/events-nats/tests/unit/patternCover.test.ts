import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverPatterns, matchesAny } from "../../src/patternCover.ts";

describe("coverPatterns", () => {
    it("returns patterns that overlap with nothing unchanged and in order", () => {
        assert.deepEqual(coverPatterns(["pay.created", "ship.*", "audit.>"]), { filters: ["pay.created", "ship.*", "audit.>"], exact: true });
    });

    it("drops a repeated pattern", () => {
        assert.deepEqual(coverPatterns(["a.b", "a.b"]), { filters: ["a.b"], exact: true });
    });

    it("drops patterns contained in another one", () => {
        assert.deepEqual(coverPatterns(["user.created", "user.*", "user.>"]), { filters: ["user.>"], exact: true });
        assert.deepEqual(coverPatterns(["user.created", "user.*"]), { filters: ["user.*"], exact: true });
        assert.deepEqual(coverPatterns(["a.b.c", "a.*.c", "a.>"]), { filters: ["a.>"], exact: true });
        assert.deepEqual(coverPatterns(["a.*.*", "a.b.*"]), { filters: ["a.*.*"], exact: true });
    });

    it("treats `>` as one or more tokens: it contains `a.b` but not `a`", () => {
        assert.deepEqual(coverPatterns(["a", "a.>"]), { filters: ["a", "a.>"], exact: true });
    });

    it("does not treat `*` as containing a longer subject or a `>` tail", () => {
        assert.deepEqual(coverPatterns(["a.*", "a.b.c"]), { filters: ["a.*", "a.b.c"], exact: true });
        assert.deepEqual(coverPatterns(["a.*", "a.b.>"]), { filters: ["a.*", "a.b.>"], exact: true });
    });

    it("replaces partly overlapping patterns by their common prefix and flags the cover as wider", () => {
        assert.deepEqual(coverPatterns(["a.*.c", "a.b.*"]), { filters: ["a.>"], exact: false });
        assert.deepEqual(coverPatterns(["x.y.*.c", "x.y.b.*"]), { filters: ["x.y.>"], exact: false });
        assert.deepEqual(coverPatterns(["a.>", "*.b"]), { filters: [">"], exact: false });
    });

    it("keeps unrelated patterns next to a widened one", () => {
        assert.deepEqual(coverPatterns(["a.*.c", "z.1", "a.b.*"]), { filters: ["z.1", "a.>"], exact: false });
    });

    it("widens repeatedly until no two filters overlap", () => {
        // a.*.c + a.b.* -> a.> ; a.> then contains a.q.r
        assert.deepEqual(coverPatterns(["a.*.c", "a.b.*", "a.q.r"]), { filters: ["a.>"], exact: false });
    });

    it("never leaves two overlapping filters, whatever the input order", () => {
        const input = ["a.*.c", "*.b.c", "a.b.*", "x.>", "x.y.*", "*.*.z"];
        for (let shift = 0; shift < input.length; shift++) {
            const rotated = [...input.slice(shift), ...input.slice(0, shift)];
            const { filters } = coverPatterns(rotated);
            for (const [i, left] of filters.entries()) {
                for (const right of filters.slice(i + 1)) {
                    for (const subject of ["a.b.c", "a.x.c", "x.y.z", "x.y", "m.n.z", "q.b.c"]) {
                        assert.ok(!(matchesAny([left], subject) && matchesAny([right], subject)), `${left} and ${right} both match ${subject} (input ${rotated.join(",")})`);
                    }
                }
            }
            for (const subject of ["a.b.c", "a.x.c", "x.y.z", "x.y", "m.n.z", "q.b.c"]) {
                if (matchesAny(input, subject)) {
                    assert.ok(matchesAny(filters, subject), `${subject} lost by the cover of ${rotated.join(",")}`);
                }
            }
        }
    });
});

describe("matchesAny", () => {
    it("follows NATS wildcard rules", () => {
        assert.equal(matchesAny(["user.*"], "user.created"), true);
        assert.equal(matchesAny(["user.*"], "user.created.v2"), false);
        assert.equal(matchesAny(["user.>"], "user"), false);
        assert.equal(matchesAny(["user.>"], "user.created.v2"), true);
        assert.equal(matchesAny(["a.b", "c.*"], "c.d"), true);
        assert.equal(matchesAny([], "c.d"), false);
    });
});
