import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";
import type { RedisBrokerOptions } from "../../src/types.ts";

/** Values a JavaScript caller can pass that are not numbers of the required kind. */
const notNumbers: readonly unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, "abc", "10", null, true, 1.5, 2 ** 53];

function create(brokerOptions: unknown): void {
    RedisAdapter({ brokerOptions: brokerOptions as RedisBrokerOptions });
}

describe("RedisAdapter brokerOptions validation", () => {
    it("accepts the defaults and valid values", () => {
        create(undefined);
        create({});
        create({ maxLen: undefined, blockMs: undefined, count: undefined });
        create({ maxLen: 1, blockMs: 0, count: 1 });
        create({ maxLen: 100_000, blockMs: 5000, count: 500 });
    });

    describe("maxLen", () => {
        // maxLen: 0 makes XADD MAXLEN ~ 0 trim every entry, so published events would vanish without an error.
        for (const value of [0, -1, ...notNumbers]) {
            it(`rejects ${String(value)}`, () => {
                assert.throws(() => create({ maxLen: value }), { name: "RangeError", message: /RedisAdapter: brokerOptions\.maxLen must be a positive safe integer/ });
            });
        }
    });

    describe("blockMs", () => {
        for (const value of [-1, ...notNumbers]) {
            it(`rejects ${String(value)}`, () => {
                assert.throws(() => create({ blockMs: value }), { name: "RangeError", message: /RedisAdapter: brokerOptions\.blockMs must be a non-negative safe integer/ });
            });
        }
    });

    describe("count", () => {
        for (const value of [0, -1, ...notNumbers]) {
            it(`rejects ${String(value)}`, () => {
                assert.throws(() => create({ count: value }), { name: "RangeError", message: /RedisAdapter: brokerOptions\.count must be a positive safe integer/ });
            });
        }
    });

    it("still throws the RangeError naming the option for values JSON cannot serialize", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        for (const value of [1n, circular, Object.create(null), Symbol("x")]) {
            assert.throws(() => create({ count: value }), { name: "RangeError", message: /brokerOptions\.count must be a positive safe integer, got / });
        }
        assert.throws(() => create({ maxLen: 1n }), { message: "RedisAdapter: brokerOptions.maxLen must be a positive safe integer, got 1" });
    });

    it("reports the offending value so the caller can find it", () => {
        assert.throws(() => create({ count: "abc" }), { message: 'RedisAdapter: brokerOptions.count must be a positive safe integer, got "abc"' });
        assert.throws(() => create({ maxLen: 0 }), { message: "RedisAdapter: brokerOptions.maxLen must be a positive safe integer, got 0" });
        assert.throws(() => create({ blockMs: Number.NaN }), { message: "RedisAdapter: brokerOptions.blockMs must be a non-negative safe integer, got NaN" });
    });
});
