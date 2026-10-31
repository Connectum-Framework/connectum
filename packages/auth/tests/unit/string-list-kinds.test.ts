/**
 * Kinds of `roles` and `scopes` arrays on every path that takes them from outside.
 *
 * A list handed over by `verifyCredentials`, `mapSession` or a direct `setAuthHeaders` call must be
 * an array of strings without holes. `every`, `map` and `filter` skip holes, so a sparse list used
 * to pass the check and then be written or used as a different list. Every path now answers the
 * same way: the call ends with `Unauthenticated` (the direct call throws), nothing is cached and no
 * header is written. A list that merely looks unusual but holds only strings (an array subclass, a
 * proxy of an array, an array with extra properties) is accepted.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { isAuthContext, MAX_LIST_ITEMS } from "../../src/auth-context-check.ts";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

class Strings extends Array<string> {}

const withExtra = Object.assign(["a", "b"], { note: "ignored" });

/** Lists the check must refuse. */
const REFUSED: Array<[string, () => unknown]> = [
    ["a sparse list", () => ["a", , "b"]], // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    ["an array of holes", () => new Array(3)],
    ["a list with undefined", () => ["a", undefined]],
    ["a list with null", () => ["a", null]],
    ["a list with a number", () => ["a", 1]],
    ["a list with an object", () => ["a", {}]],
    ["a list with a symbol", () => ["a", Symbol("s")]],
    ["a list with a nested array", () => ["a", ["b"]]],
    ["a string instead of a list", () => "abc"],
    ["an array-like object", () => ({ 0: "a", length: 1 })],
    ["a long sparse array (1e6 holes)", () => new Array(1_000_000)],
    ["a list one item over the limit", () => Array.from({ length: MAX_LIST_ITEMS + 1 }, () => "r")],
    ["a proxy that reports a huge length", () => new Proxy(["a"], { get: (target, key) => (key === "length" ? 1e9 : Reflect.get(target, key)) })],
    [
        "a list whose item getter throws",
        () => {
            const list = ["a", "b"];
            Object.defineProperty(list, 1, {
                get() {
                    throw new Error("boom");
                },
            });
            return list;
        },
    ],
];

/** Lists the check accepts: they hold only strings. */
const ACCEPTED: Array<[string, () => unknown]> = [
    ["an empty list", () => []],
    ["a dense list", () => ["a", "b"]],
    ["a list at the item limit", () => Array.from({ length: MAX_LIST_ITEMS }, () => "r")],
    ["an array subclass", () => Strings.from(["a", "b"])],
    ["a proxy of an array", () => new Proxy(["a", "b"], {})],
    ["a list with extra properties", () => withExtra],
];

function headers(): Headers {
    return new Headers({ authorization: "Bearer any-token" });
}

for (const field of ["roles", "scopes"] as const) {
    describe(`${field}: arrays that must be refused`, () => {
        for (const [label, make] of REFUSED) {
            it(`isAuthContext refuses ${label}`, () => {
                assert.strictEqual(isAuthContext({ ...createMockAuthContext(), [field]: make() }), false);
            });

            for (const propagateHeaders of [false, true]) {
                it(`createAuthInterceptor answers Unauthenticated for ${label} (propagateHeaders: ${propagateHeaders})`, async () => {
                    let verifications = 0;
                    const interceptor = createAuthInterceptor({
                        verifyCredentials: async () => {
                            verifications++;
                            return { ...createMockAuthContext(), [field]: make() } as never;
                        },
                        cache: { ttl: 60_000 },
                        propagateHeaders,
                    });
                    const next = createMockNext();
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        const req = createMockRequest({ headers: headers() });
                        await assert.rejects(
                            () => interceptor(next)(req),
                            (err: unknown) => {
                                assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                                return true;
                            },
                        );
                        assert.strictEqual(req.header.get("x-auth-subject"), null, "no header was written");
                        assert.strictEqual(verifications, attempt, "the refused list was not cached");
                    }
                    assert.strictEqual(next.mock.calls.length, 0);
                });

                it(`createSessionAuthInterceptor answers Unauthenticated for ${label} (propagateHeaders: ${propagateHeaders})`, async () => {
                    const interceptor = createSessionAuthInterceptor({
                        verifySession: async () => ({}),
                        mapSession: async () => ({ ...createMockAuthContext(), [field]: make() }) as never,
                        propagateHeaders,
                    });
                    const next = createMockNext();
                    await assert.rejects(
                        () => interceptor(next)(createMockRequest({ headers: headers() })),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated, "Session mapping failed");
                            return true;
                        },
                    );
                    assert.strictEqual(next.mock.calls.length, 0);
                });
            }

            it(`setAuthHeaders refuses ${label} and writes no header`, () => {
                const out = new Headers();
                assert.throws(
                    () => setAuthHeaders(out, { ...createMockAuthContext(), [field]: make() } as never),
                    (err: unknown) => err instanceof UnsafeHeaderValueError && err.field === field && /array of at most 8192 strings/.test(err.message),
                );
                assert.deepStrictEqual([...out.keys()], []);
            });
        }
    });

    describe(`${field}: unusual arrays that hold only strings`, () => {
        for (const [label, make] of ACCEPTED) {
            it(`isAuthContext accepts ${label}`, () => {
                assert.strictEqual(isAuthContext({ ...createMockAuthContext(), [field]: make() }), true);
            });
        }
    });
}

describe("a refused list is refused promptly", () => {
    it("does not walk a list of 1e9 holes or a proxy with a huge length", () => {
        const started = performance.now();
        assert.strictEqual(isAuthContext({ ...createMockAuthContext(), roles: new Array(1e9) }), false);
        assert.strictEqual(isAuthContext({ ...createMockAuthContext(), scopes: new Proxy(["a"], { get: (t, k) => (k === "length" ? 1e9 : Reflect.get(t, k)) }) }), false);
        assert.ok(performance.now() - started < 1000, "answered without a walk over the length");
    });
});
