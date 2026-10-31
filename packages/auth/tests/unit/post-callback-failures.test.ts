/**
 * Hostile results of `verifyCredentials` and `mapSession` that pass the shape check but break the
 * code that works on them afterwards.
 *
 * The shape check does not read extra properties of the context or the keys inside `claims`. The
 * steps after it (copying the identity for the cache, serializing it into headers) do, so a getter
 * that throws, a proxy whose traps throw, a cyclic or BigInt claim and a value whose `toJSON`
 * throws can fail there. Every such failure ends the call with `Unauthenticated`, never with the
 * raw error (which a client would see as `internal`), nothing is cached and the handler does not
 * run. Where no failing step is active the identity is admitted as before.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

interface Hostile {
    label: string;
    /** A fresh hostile identity. */
    make: () => unknown;
    /** Whether the cache copy fails for it. */
    copyFails: boolean;
    /** Whether the header serialization fails for it. */
    propagateFails: boolean;
}

const HOSTILE: Hostile[] = [
    {
        label: "an enumerable context property whose getter throws",
        make: () => {
            const context = createMockAuthContext();
            Object.defineProperty(context, "extra", {
                enumerable: true,
                get() {
                    throw new Error("boom");
                },
            });
            return context;
        },
        copyFails: true,
        propagateFails: false,
    },
    {
        label: "a claims key whose getter throws",
        make: () => {
            const claims: Record<string, unknown> = {};
            Object.defineProperty(claims, "k", {
                enumerable: true,
                get() {
                    throw new Error("boom");
                },
            });
            return { ...createMockAuthContext(), claims };
        },
        copyFails: true,
        propagateFails: true,
    },
    {
        label: "claims that are a proxy with throwing traps",
        make: () => {
            const trap = () => {
                throw new Error("boom");
            };
            return { ...createMockAuthContext(), claims: new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap }) };
        },
        copyFails: true,
        propagateFails: true,
    },
    {
        label: "a cyclic claim",
        make: () => {
            const claims: Record<string, unknown> = { a: 1 };
            claims.self = claims;
            return { ...createMockAuthContext(), claims };
        },
        copyFails: false,
        propagateFails: true,
    },
    {
        label: "a BigInt claim",
        make: () => ({ ...createMockAuthContext(), claims: { n: 10n } }),
        copyFails: false,
        propagateFails: true,
    },
    {
        label: "a claim whose toJSON throws",
        make: () => {
            class Boom {
                toJSON(): never {
                    throw new Error("boom");
                }
            }
            return { ...createMockAuthContext(), claims: { b: new Boom() } };
        },
        copyFails: false,
        propagateFails: true,
    },
];

function headers(): Headers {
    return new Headers({ authorization: "Bearer any-token" });
}

for (const kind of ["createAuthInterceptor", "createSessionAuthInterceptor"] as const) {
    describe(`${kind}: failures after the callback returned`, () => {
        for (const hostile of HOSTILE) {
            for (const cache of [false, true]) {
                for (const propagateHeaders of [false, true]) {
                    const fails = (cache && hostile.copyFails) || (propagateHeaders && hostile.propagateFails);
                    // Propagation runs before the cache copy, so its message wins when both fail.
                    const message = kind === "createSessionAuthInterceptor" && !(propagateHeaders && hostile.propagateFails) ? "Session mapping failed" : "Authentication failed";

                    it(`${hostile.label}, cache ${cache}, propagateHeaders ${propagateHeaders}: ${fails ? "Unauthenticated, not cached" : "admitted"}`, async () => {
                        let calls = 0;
                        const interceptor =
                            kind === "createAuthInterceptor"
                                ? createAuthInterceptor({
                                      verifyCredentials: async () => {
                                          calls++;
                                          return hostile.make() as never;
                                      },
                                      propagateHeaders,
                                      ...(cache ? { cache: { ttl: 60_000 } } : {}),
                                  })
                                : createSessionAuthInterceptor({
                                      verifySession: async () => ({}),
                                      mapSession: async () => {
                                          calls++;
                                          return hostile.make() as never;
                                      },
                                      propagateHeaders,
                                      ...(cache ? { cache: { ttl: 60_000 } } : {}),
                                  });
                        const next = createMockNext();

                        for (let attempt = 1; attempt <= 2; attempt++) {
                            const outcome = interceptor(next)(createMockRequest({ headers: headers() }));
                            if (fails) {
                                await assert.rejects(outcome, (err: unknown) => {
                                    assertConnectError(err, Code.Unauthenticated, message);
                                    return true;
                                });
                                assert.strictEqual(calls, attempt, "a refused identity was not cached");
                            } else {
                                await outcome;
                                assert.strictEqual(calls, cache ? 1 : attempt, cache ? "the second request came from the cache" : "no cache");
                            }
                        }
                        assert.strictEqual(next.mock.calls.length, fails ? 0 : 2);
                    });
                }
            }
        }
    });
}
