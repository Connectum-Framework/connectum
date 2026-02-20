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
import { getAuthContext } from "../../src/context.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

/** Create a mock ConnectRPC request for testing interceptors. */
function createMockRequest(options?: {
    serviceName?: string;
    methodName?: string;
    headers?: Headers;
}) {
    const serviceName = options?.serviceName ?? "test.v1.TestService";
    const methodName = options?.methodName ?? "TestMethod";
    const headers = options?.headers ?? new Headers();

    return {
        service: { typeName: serviceName },
        method: { name: methodName },
        header: headers,
        url: `http://localhost/${serviceName}/${methodName}`,
        stream: false,
        message: {},
    } as any;
}

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

            const req = createMockRequest(); // no authorization header
            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Missing credentials/);
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
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Session verification failed/);
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
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.ResourceExhausted);
                    assert.match(err.message, /Custom verify error/);
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
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Session mapping failed/);
                    return true;
                },
            );
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
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.InvalidArgument);
                    assert.match(err.message, /Custom map error/);
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

            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "spoofed-user");
            headers.set(AUTH_HEADERS.TYPE, "spoofed-type");
            const req = createMockRequest({ methodName: "Health", headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(verifySession.mock.calls.length, 0); // not called
            // Auth headers should be stripped to prevent spoofing
            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), null);
            assert.strictEqual(req.header.get(AUTH_HEADERS.TYPE), null);
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
            const req = createMockRequest({ headers });

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
