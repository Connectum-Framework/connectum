/**
 * Unit tests for the generic authentication interceptor
 *
 * Tests createAuthInterceptor() for credential extraction, verification,
 * skip patterns, context propagation, and error handling.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

function createMockRequest(overrides: Record<string, unknown> = {}) {
    return {
        service: { typeName: "test.Service" },
        method: { name: "Method" },
        header: new Headers(),
        url: "http://localhost/test.Service/Method",
        stream: false,
        message: {},
        ...overrides,
    } as any;
}

function createMockNext() {
    return mock.fn(async (_req: any) => ({ message: {} })) as any;
}

describe("auth-interceptor", () => {
    describe("createAuthInterceptor()", () => {
        it("should extract Bearer token and call verifyCredentials", async () => {
            const expectedContext: AuthContext = {
                subject: "user-1",
                roles: ["admin"],
                scopes: ["read"],
                claims: {},
                type: "jwt",
            };

            const verifyCredentials = mock.fn(async (token: string) => {
                assert.strictEqual(token, "my-token-123");
                return expectedContext;
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("authorization", "Bearer my-token-123");

            await handler(req);

            assert.strictEqual(verifyCredentials.mock.calls.length, 1);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should throw Unauthenticated when no Authorization header", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should throw Unauthenticated when verifyCredentials throws", async () => {
            const verifyCredentials = mock.fn(async () => {
                throw new Error("Invalid token");
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("authorization", "Bearer bad-token");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.ok(err.message.includes("Authentication failed"));
                    return true;
                },
            );
        });

        it("should pass through ConnectError from verifyCredentials", async () => {
            const verifyCredentials = mock.fn(async () => {
                throw new ConnectError("Token expired", Code.PermissionDenied);
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("authorization", "Bearer expired-token");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    assert.ok(err.message.includes("Token expired"));
                    return true;
                },
            );
        });

        it("should skip auth for matching skipMethods patterns (exact)", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({
                verifyCredentials: verifyCredentials as any,
                skipMethods: ["test.Service/Method"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await handler(req);

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should skip auth for matching skipMethods patterns (wildcard)", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({
                verifyCredentials: verifyCredentials as any,
                skipMethods: ["test.Service/*"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await handler(req);

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should set auth context in AsyncLocalStorage", async () => {
            const expectedContext: AuthContext = {
                subject: "als-user",
                roles: ["viewer"],
                scopes: ["read"],
                claims: { custom: true },
                type: "jwt",
            };

            const verifyCredentials = mock.fn(async () => expectedContext);

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("authorization", "Bearer test-token");

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "als-user");
            assert.deepStrictEqual(capturedContext.roles, ["viewer"]);
            assert.deepStrictEqual(capturedContext.claims, { custom: true });
        });

        it("should propagate headers when propagateHeaders is true", async () => {
            const expectedContext: AuthContext = {
                subject: "propagated-user",
                roles: ["admin"],
                scopes: ["write"],
                claims: {},
                type: "jwt",
            };

            const verifyCredentials = mock.fn(async () => expectedContext);

            const interceptor = createAuthInterceptor({
                verifyCredentials: verifyCredentials as any,
                propagateHeaders: true,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("authorization", "Bearer test-token");

            await handler(req);

            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "propagated-user");
            assert.strictEqual(req.header.get(AUTH_HEADERS.TYPE), "jwt");
            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), JSON.stringify(["admin"]));
            assert.strictEqual(req.header.get(AUTH_HEADERS.SCOPES), "write");
        });
    });
});
