/**
 * Integration tests for session-auth-interceptor edge cases.
 *
 * Covers: error handling (verifySession/mapSession regular Error,
 * ConnectError re-throw), skipMethods strip, custom extractToken,
 * missing credentials.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.v1.TestService", method: "TestMethod" } as const;

const validMapSession = (session: unknown): AuthContext => {
    const s = session as { userId: string };
    return {
        subject: s.userId,
        roles: ["user"],
        scopes: [],
        claims: {},
        type: "session",
    };
};

describe("Session Auth Edge Cases — Integration", () => {
    describe("error handling", () => {
        it("should throw Unauthenticated when no token is present", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => ({ userId: "u" }),
                mapSession: validMapSession,
            });

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS); // no authorization header
            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, /Missing credentials/);
                    return true;
                },
            );
        });

        it("should wrap regular Error from verifySession as 'Session verification failed'", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => {
                    throw new Error("DB connection lost");
                },
                mapSession: validMapSession,
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer valid-token");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, /Session verification failed/);
                    return true;
                },
            );
        });

        it("should re-throw ConnectError from verifySession", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => {
                    throw new ConnectError("Custom verify error", Code.ResourceExhausted);
                },
                mapSession: validMapSession,
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer valid-token");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.ResourceExhausted, /Custom verify error/);
                    return true;
                },
            );
        });

        it("should wrap regular Error from mapSession as 'Session mapping failed'", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => ({ userId: "u1" }),
                mapSession: () => {
                    throw new Error("Unexpected format");
                },
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer valid-token");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, /Session mapping failed/);
                    return true;
                },
            );
            // Fail closed: the call is refused before the handler runs.
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // Guide: a backend response that cannot be mapped is rejected with Unauthenticated.
        // The refusal must not leave anything behind in the cache that would let the same
        // token through on the next call without being mapped again.
        it("should not cache a session whose mapping failed", async () => {
            let mappings = 0;
            const verifySession = mock.fn(async () => ({ userId: "u1" }));
            const interceptor = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: (session) => {
                    mappings++;
                    if (mappings === 1) throw new Error("Unexpected format");
                    return validMapSession(session);
                },
                cache: { ttl: 60_000 },
            });
            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            const call = () => handler(createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers: new Headers({ authorization: "Bearer same-token" }) }));

            await assert.rejects(call(), (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated);
                return true;
            });
            assert.strictEqual(next.mock.calls.length, 0);

            await call();
            assert.strictEqual(verifySession.mock.calls.length, 2, "the failed attempt must not be served from the cache");
            assert.strictEqual(mappings, 2);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should re-throw ConnectError from mapSession", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => ({ userId: "u1" }),
                mapSession: () => {
                    throw new ConnectError("Custom map error", Code.InvalidArgument);
                },
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer valid-token");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument, /Custom map error/);
                    return true;
                },
            );
        });
    });

    describe("skipMethods", () => {
        it("should strip auth headers and skip verification for skipped methods", async () => {
            const verifySession = mock.fn(async () => ({ userId: "u1" }));

            const interceptor = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: validMapSession,
                skipMethods: ["test.v1.TestService/Health"],
            });

            // Guide: the interceptor removes incoming x-auth-* identity headers. A client could
            // send any of the six to impersonate a caller on a method that skips authentication,
            // so all six are planted and what the next handler sees is inspected from inside it.
            const identityHeaders = ["x-auth-subject", "x-auth-type", "x-auth-name", "x-auth-roles", "x-auth-scopes", "x-auth-claims"];
            const headers = new Headers();
            for (const name of identityHeaders) headers.set(name, "spoofed");
            headers.set("x-unrelated", "keep-me");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, method: "Health", headers });

            let seenByNext: Record<string, string | null> = {};
            const next = mock.fn(async (r: { header: Headers }) => {
                seenByNext = Object.fromEntries([...identityHeaders, "x-unrelated"].map((name) => [name, r.header.get(name)]));
                return { message: {} };
            });
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(verifySession.mock.calls.length, 0); // not called
            assert.deepStrictEqual(seenByNext, {
                "x-auth-subject": null,
                "x-auth-type": null,
                "x-auth-name": null,
                "x-auth-roles": null,
                "x-auth-scopes": null,
                "x-auth-claims": null,
                "x-unrelated": "keep-me",
            });
        });

        // Skipping is per method: a method that is not listed still needs a credential, so a
        // non-empty skipMethods list cannot turn authentication off for the whole service.
        it("should still require credentials on a method that is not in skipMethods", async () => {
            const verifySession = mock.fn(async () => ({ userId: "u1" }));
            const interceptor = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: validMapSession,
                skipMethods: ["test.v1.TestService/Health"],
            });
            const next = mock.fn(async () => ({ message: {} }));

            await assert.rejects(interceptor(next as any)(createMockRequest({ ...MOCK_REQUEST_DEFAULTS, method: "Other" })), (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated);
                return true;
            });
            assert.strictEqual(next.mock.calls.length, 0);
        });
    });

    describe("custom extractToken", () => {
        it("should use custom extractToken function", async () => {
            const interceptor = createSessionAuthInterceptor({
                extractToken: (req) => req.header.get("x-api-token"),
                verifySession: async (token) => ({ userId: token }),
                mapSession: validMapSession,
            });

            const headers = new Headers();
            headers.set("x-api-token", "custom-token-123");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(captured);
            assert.strictEqual(captured.subject, "custom-token-123");
        });
    });
});
