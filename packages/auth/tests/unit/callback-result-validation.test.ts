/**
 * A verifier callback that returns something other than an identity must not authenticate the call.
 *
 * `verifyCredentials` and `mapSession` are documented to throw on bad credentials, but a typical
 * slip is `return db.find(key)` that yields `null`. Such a result ends the call with
 * Unauthenticated, with propagation on and off, and is never cached; it must not surface as an
 * internal error and must not let the handler run without an identity.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

const GOOD = createMockAuthContext();

const NOT_IDENTITIES: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["true", true],
    ["a string", "alice"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["an object without type, roles, scopes and claims", { subject: "alice" }],
    ["a numeric subject", { ...GOOD, subject: 42 }],
    ["a missing subject", { ...GOOD, subject: undefined }],
    ["a missing type", { ...GOOD, type: undefined }],
    ["roles that are not an array", { ...GOOD, roles: "admin" }],
    ["roles with a non-string item", { ...GOOD, roles: ["user", 7] }],
    ["scopes that are not an array", { ...GOOD, scopes: "read" }],
    ["scopes with a non-string item", { ...GOOD, scopes: [null] }],
    ["null claims", { ...GOOD, claims: null }],
    ["claims that are an array", { ...GOOD, claims: [] }],
    ["a non-string name", { ...GOOD, name: 5 }],
    ["an expiresAt that is not a Date", { ...GOOD, expiresAt: "2099-01-01" }],
];

function headers(): Headers {
    return new Headers({ authorization: "Bearer any-token" });
}

describe("verifier callback result", () => {
    for (const propagateHeaders of [true, false]) {
        describe(`propagateHeaders: ${propagateHeaders}`, () => {
            for (const [label, value] of NOT_IDENTITIES) {
                it(`createAuthInterceptor: ${label} from verifyCredentials is Unauthenticated, not cached, handler not called`, async () => {
                    let verifications = 0;
                    const interceptor = createAuthInterceptor({
                        verifyCredentials: async () => {
                            verifications++;
                            return value as never;
                        },
                        cache: { ttl: 60_000 },
                        propagateHeaders,
                    });
                    const next = createMockNext();

                    for (let attempt = 1; attempt <= 2; attempt++) {
                        await assert.rejects(
                            () => interceptor(next)(createMockRequest({ headers: headers() })),
                            (err: unknown) => {
                                assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                                return true;
                            },
                        );
                        assert.strictEqual(verifications, attempt, "the rejected result was not served from the cache");
                    }
                    assert.strictEqual(next.mock.calls.length, 0);
                });

                it(`createSessionAuthInterceptor: ${label} from mapSession is Unauthenticated, not cached, handler not called`, async () => {
                    let mappings = 0;
                    const interceptor = createSessionAuthInterceptor({
                        verifySession: async () => ({ ok: true }),
                        mapSession: async () => {
                            mappings++;
                            return value as never;
                        },
                        cache: { ttl: 60_000 },
                        propagateHeaders,
                    });
                    const next = createMockNext();

                    for (let attempt = 1; attempt <= 2; attempt++) {
                        await assert.rejects(
                            () => interceptor(next)(createMockRequest({ headers: headers() })),
                            (err: unknown) => {
                                assertConnectError(err, Code.Unauthenticated, "Session mapping failed");
                                return true;
                            },
                        );
                        assert.strictEqual(mappings, attempt, "the rejected result was not served from the cache");
                    }
                    assert.strictEqual(next.mock.calls.length, 0);
                });
            }

            it("admits a well-formed identity with optional fields set", async () => {
                const interceptor = createAuthInterceptor({
                    verifyCredentials: async () => ({ ...GOOD, name: "Alice", expiresAt: new Date(Date.now() + 60_000) }),
                    propagateHeaders,
                });
                const next = createMockNext();

                await interceptor(next)(createMockRequest({ headers: headers() }));

                assert.strictEqual(next.mock.calls.length, 1);
            });
        });
    }
});
