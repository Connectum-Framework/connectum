/**
 * Unit tests for the option validators shared by the interceptor factories
 *
 * @module validate.test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { MAX_TIMER_MS, requireDefaultOption, requireFiniteNumber, requireInteger } from "../../src/validate.ts";

const base = { caller: "createX", option: "size" } as const;

describe("MAX_TIMER_MS", () => {
    it("is the largest delay the platform timer honours (2^31 - 1)", () => {
        assert.strictEqual(MAX_TIMER_MS, 2 ** 31 - 1);
    });
});

describe("requireInteger", () => {
    it("accepts both bounds of an inclusive range", () => {
        requireInteger({ ...base, value: 1, min: 1, max: 5 });
        requireInteger({ ...base, value: 5, min: 1, max: 5 });
    });

    it("accepts any large integer when there is no upper bound", () => {
        requireInteger({ ...base, value: Number.MAX_SAFE_INTEGER, min: 1 });
    });

    it("refuses a value one past either bound with a RangeError", () => {
        assert.throws(() => requireInteger({ ...base, value: 0, min: 1, max: 5 }), RangeError);
        assert.throws(() => requireInteger({ ...base, value: 6, min: 1, max: 5 }), RangeError);
    });

    it("refuses a fraction, NaN and the infinities with a RangeError", () => {
        for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            assert.throws(() => requireInteger({ ...base, value, min: 0 }), RangeError, String(value));
        }
    });

    it("refuses every non-number with a TypeError", () => {
        for (const value of ["1", null, undefined, true, 1n, {}, [], () => 1, Symbol("s")]) {
            assert.throws(() => requireInteger({ ...base, value, min: 0 }), TypeError, String(typeof value));
        }
    });

    it("builds the message from the factory, option, range, unit and the received value", () => {
        assert.throws(
            () => requireInteger({ ...base, value: 0.5, min: 1, max: 5, unit: "milliseconds" }),
            (err: unknown) => err instanceof RangeError && err.message === "createX: size must be an integer from 1 to 5 milliseconds, got 0.5",
        );
        assert.throws(
            () => requireInteger({ ...base, value: -1, min: 0 }),
            (err: unknown) => err instanceof RangeError && err.message === "createX: size must be an integer of at least 0, got -1",
        );
    });

    it("renders each kind of received value readably and without throwing", () => {
        const messageFor = (value: unknown): string => {
            try {
                requireInteger({ ...base, value, min: 0 });
            } catch (err) {
                return (err as Error).message;
            }
            return "";
        };
        assert.ok(messageFor("30s").endsWith('got "30s"'));
        assert.ok(messageFor(null).endsWith("got null"));
        assert.ok(messageFor(undefined).endsWith("got undefined"));
        assert.ok(messageFor(5n).endsWith("got 5n"));
        assert.ok(messageFor([]).endsWith("got an array"));
        assert.ok(messageFor({}).endsWith("got an object"));
        assert.ok(messageFor(Object.create(null)).endsWith("got an object"));
        assert.ok(messageFor(() => 1).endsWith("got a function"));
        assert.ok(messageFor(Symbol("s")).endsWith("got Symbol(s)"));
    });
});

describe("requireFiniteNumber", () => {
    it("accepts fractions and the minimum", () => {
        requireFiniteNumber({ ...base, value: 0, min: 0 });
        requireFiniteNumber({ ...base, value: 0.5, min: 0 });
    });

    it("refuses a value below the minimum, NaN and the infinities with a RangeError", () => {
        for (const value of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.throws(() => requireFiniteNumber({ ...base, value, min: 0 }), RangeError, String(value));
        }
    });

    it("refuses a non-number with a TypeError", () => {
        assert.throws(
            () => requireFiniteNumber({ ...base, value: "3", min: 0 }),
            (err: unknown) => err instanceof TypeError && err.message === 'createX: size must be a finite number of at least 0, got "3"',
        );
    });
});

describe("requireDefaultOption", () => {
    it("lets undefined and false through for every kind", () => {
        for (const kind of ["toggle", "fallback", "boolean"] as const) {
            requireDefaultOption({ option: "k", value: undefined, kind });
            requireDefaultOption({ option: "k", value: false, kind });
        }
    });

    it("accepts true for toggle and boolean but not for fallback", () => {
        requireDefaultOption({ option: "k", value: true, kind: "toggle" });
        requireDefaultOption({ option: "k", value: true, kind: "boolean" });
        assert.throws(() => requireDefaultOption({ option: "k", value: true, kind: "fallback" }), TypeError);
    });

    it("accepts a plain object for toggle and fallback but not for boolean", () => {
        requireDefaultOption({ option: "k", value: {}, kind: "toggle" });
        requireDefaultOption({ option: "k", value: { handler: () => 1 }, kind: "fallback" });
        assert.throws(() => requireDefaultOption({ option: "k", value: {}, kind: "boolean" }), TypeError);
    });

    it("refuses null and arrays for every kind", () => {
        for (const kind of ["toggle", "fallback", "boolean"] as const) {
            assert.throws(() => requireDefaultOption({ option: "k", value: null, kind }), TypeError);
            assert.throws(() => requireDefaultOption({ option: "k", value: [], kind }), TypeError);
        }
    });
});
