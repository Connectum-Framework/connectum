import assert from "node:assert";
import { describe, it } from "node:test";
import { Healthcheck } from "../../src/Healthcheck.ts";

describe("Healthcheck() watchInterval", () => {
    for (const [label, value] of [
        ["zero", 0],
        ["a negative number", -5],
        ["a fraction", 1.5],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["2147483648", 2_147_483_648],
    ] as Array<[string, number]>) {
        it(`throws RangeError naming watchInterval for ${label}`, () => {
            assert.throws(
                () => Healthcheck({ watchInterval: value }),
                (err: unknown) => err instanceof RangeError && /Healthcheck\(\)/.test(err.message) && /watchInterval/.test(err.message) && err.message.includes(String(value)),
            );
        });
    }

    for (const [label, value] of [
        ["a string", "abc"],
        ["a numeric string", "500"],
        ["null", null],
        ["a boolean", true],
        ["an object", {}],
    ] as Array<[string, unknown]>) {
        it(`throws TypeError naming watchInterval for ${label}`, () => {
            assert.throws(
                () => Healthcheck({ watchInterval: value as number }),
                (err: unknown) => err instanceof TypeError && /watchInterval/.test(err.message),
            );
        });
    }

    it("accepts the boundaries and an omitted or undefined value", () => {
        for (const watchInterval of [1, 500, 2_147_483_647]) {
            assert.strictEqual(Healthcheck({ watchInterval }).name, "healthcheck");
        }
        // Plain JavaScript callers and spread option objects do pass undefined.
        assert.strictEqual(Healthcheck({ watchInterval: undefined } as never).name, "healthcheck");
    });
});
