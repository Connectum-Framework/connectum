/**
 * Lengths and other unusual shapes of the arrays accepted as `roles` and `scopes`.
 *
 * A real array always has a safe-integer length, so only a proxy of an array can report anything
 * else. The list check reads the length once and accepts it only when it is a number that is a
 * non-negative safe integer within the item limit; the rows below run each kind through every
 * path. A string or object length, `NaN`, a negative, fractional or infinite number, a
 * `bigint` and an object with `Symbol.toPrimitive` or `valueOf` all end the call with
 * `Unauthenticated` (the direct writer throws). The old check handed the length to `every`, which
 * coerces it: `NaN` and `-1` became 0 and the proxy passed as an empty list whatever it held.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { isAuthContext, isStringList, MAX_LIST_ITEMS } from "../../src/auth-context-check.ts";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

/** A proxy of an array of strings that reports `length` instead of the real one. */
function withLength(length: unknown): unknown {
    return new Proxy(["a", "b"], { get: (target, key) => (key === "length" ? length : Reflect.get(target, key)) });
}

/** Lengths a proxy can report that the check must refuse; none of them makes the old check hang. */
const BAD_LENGTHS: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["a negative number", -1],
    ["a negative fraction", -0.5],
    ["a fractional number", 1.5],
    ["a string number", "2"],
    ["a non-numeric string", "abc"],
    ["a bigint", 2n],
    ["undefined", undefined],
    ["null", null],
    ["an object with valueOf", { valueOf: () => 2 }],
    ["an object with Symbol.toPrimitive", { [Symbol.toPrimitive]: () => 2 }],
    ["a boolean", true],
    ["one over the item limit", MAX_LIST_ITEMS + 1],
];

/** Lengths whose old handling loops for ever or for 2^53 steps; refused too, but only run against the new check. */
const HANGING_LENGTHS: Array<[string, unknown]> = [
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number above the safe integers", 2 ** 53],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
    ["1e9", 1e9],
];

const ACCEPTED: Array<[string, () => unknown]> = [
    ["a proxy with the real length", () => new Proxy(["a", "b"], {})],
    ["a proxy with has and ownKeys traps", () => new Proxy(["a", "b"], { has: () => false, ownKeys: () => [] })],
    ["a frozen list", () => Object.freeze(["a", "b"])],
    ["a sealed list", () => Object.seal(["a", "b"])],
    ["an array whose length was set by defineProperty", () => Object.defineProperty(["a", "b", "c"], "length", { value: 2 })],
    ["a list of exactly the item limit", () => Array.from({ length: MAX_LIST_ITEMS }, () => "r")],
    ["an empty list", () => []],
    ["a proxy reporting length 0", () => withLength(0)],
];

const OTHER_REFUSED: Array<[string, () => unknown]> = [
    ["a list of String objects", () => [new String("a")]],
    ["a revoked proxy", () => {
        const { proxy, revoke } = Proxy.revocable(["a"], {});
        revoke();
        return proxy;
    }],
    ["a list over the limit that is all holes", () => new Array(MAX_LIST_ITEMS + 1)],
    ["a list over the limit made of strings", () => Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "r")],
    ["a proxy whose length getter throws", () => new Proxy(["a"], { get: (t, k) => { if (k === "length") throw new Error("boom"); return Reflect.get(t, k); } })],
    ["a proxy whose length getter returns a throwing toPrimitive object", () => withLength({ [Symbol.toPrimitive]: () => { throw new Error("boom"); } })],
];

function headers(): Headers {
    return new Headers({ authorization: "Bearer any-token" });
}

/** Every path that takes the list, as a function from the list to what it does with it. */
async function pathsRefuse(field: "roles" | "scopes", make: () => unknown, label: string): Promise<void> {
    assert.strictEqual(isAuthContext({ ...createMockAuthContext(), [field]: make() }), false, `isAuthContext: ${label}`);

    for (const propagateHeaders of [false, true]) {
        const interceptor = createAuthInterceptor({ verifyCredentials: async () => ({ ...createMockAuthContext(), [field]: make() }) as never, propagateHeaders });
        const next = createMockNext();
        await assert.rejects(
            () => interceptor(next)(createMockRequest({ headers: headers() })),
            (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                return true;
            },
            `createAuthInterceptor (propagateHeaders: ${propagateHeaders}): ${label}`,
        );
        assert.strictEqual(next.mock.calls.length, 0);

        const session = createSessionAuthInterceptor({ verifySession: async () => ({}), mapSession: async () => ({ ...createMockAuthContext(), [field]: make() }) as never, propagateHeaders });
        await assert.rejects(
            () => session(createMockNext())(createMockRequest({ headers: headers() })),
            (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated, "Session mapping failed");
                return true;
            },
            `createSessionAuthInterceptor (propagateHeaders: ${propagateHeaders}): ${label}`,
        );
    }

    const out = new Headers();
    assert.throws(
        () => setAuthHeaders(out, { ...createMockAuthContext(), [field]: make() } as never),
        (err: unknown) => err instanceof UnsafeHeaderValueError && err.field === field,
        `setAuthHeaders: ${label}`,
    );
    assert.deepStrictEqual([...out.keys()], []);
}

for (const field of ["roles", "scopes"] as const) {
    describe(`${field}: reported lengths`, () => {
        for (const [label, length] of [...BAD_LENGTHS, ...HANGING_LENGTHS]) {
            it(`every path refuses a proxy that reports ${label}`, async () => {
                await pathsRefuse(field, () => withLength(length), label);
            });
        }
    });

    describe(`${field}: other shapes`, () => {
        for (const [label, make] of OTHER_REFUSED) {
            it(`every path refuses ${label}`, async () => {
                await pathsRefuse(field, make, label);
            });
        }

        for (const [label, make] of ACCEPTED) {
            it(`isAuthContext accepts ${label}`, () => {
                assert.strictEqual(isAuthContext({ ...createMockAuthContext(), [field]: make() }), true);
            });
        }
    });
}

describe("isStringList reads the length once and the items once each", () => {
    it("reads length a single time and every index a single time", () => {
        const reads: Array<string | symbol> = [];
        const list = new Proxy(["a", "b", "c"], {
            get(target, key) {
                reads.push(key);
                return Reflect.get(target, key);
            },
        });
        assert.strictEqual(isStringList(list), true);
        assert.deepStrictEqual(reads.filter((key) => key === "length").length, 1);
        assert.deepStrictEqual(reads.filter((key) => key === "0" || key === "1" || key === "2"), ["0", "1", "2"]);
    });
});
