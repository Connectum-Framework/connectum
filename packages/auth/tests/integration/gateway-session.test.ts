/**
 * Integration tests for Gateway and Session auth interceptors
 *
 * Tests the full chain: gateway/session authentication followed by
 * authorization and header propagation.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

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

describe("Gateway + Session Auth Integration", () => {
    describe("Gateway auth → Authz chain", () => {
        it("should allow gateway-authenticated admin through authz", async () => {
            const gatewayAuth = createGatewayAuthInterceptor({
                headerMapping: {
                    subject: "x-user-id",
                    roles: "x-user-roles",
                },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["test-secret"],
                },
            });

            const authz = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-access",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "test-secret");
            headers.set("x-user-id", "admin-1");
            headers.set("x-user-roles", '["admin"]');
            const req = createMockRequest({ headers });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = gatewayAuth(authz(next as any) as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "admin-1");
            assert.deepStrictEqual([...capturedContext.roles], ["admin"]);
        });

        it("should deny gateway-authenticated user without required role", async () => {
            const gatewayAuth = createGatewayAuthInterceptor({
                headerMapping: {
                    subject: "x-user-id",
                    roles: "x-user-roles",
                },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["test-secret"],
                },
            });

            const authz = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "test-secret");
            headers.set("x-user-id", "viewer-1");
            headers.set("x-user-roles", '["viewer"]');
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = gatewayAuth(authz(next as any) as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    return true;
                },
            );
        });
    });

    describe("Session auth → Authz chain with caching", () => {
        it("should verify session, set context, and pass authz", async () => {
            const verifySession = mock.fn(async () => ({
                user: { id: "session-user-1", name: "Session User" },
            }));

            const sessionAuth = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: (session: unknown) => {
                    const s = session as { user: { id: string; name: string } };
                    return {
                        subject: s.user.id,
                        name: s.user.name,
                        roles: ["user"],
                        scopes: ["read"],
                        claims: {},
                        type: "session",
                    };
                },
                cache: { ttl: 60_000 },
            });

            const authz = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "user-read",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["user"] },
                        effect: "allow",
                    },
                ],
            });

            // First request
            const headers1 = new Headers();
            headers1.set("authorization", "Bearer session-token-1");
            const req1 = createMockRequest({ headers: headers1 });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = sessionAuth(authz(next as any) as any);
            await handler(req1);

            assert.strictEqual(verifySession.mock.calls.length, 1);
            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "session-user-1");

            // Second request with same token — should use cache
            const headers2 = new Headers();
            headers2.set("authorization", "Bearer session-token-1");
            const req2 = createMockRequest({ headers: headers2 });
            await handler(req2);

            assert.strictEqual(verifySession.mock.calls.length, 1); // Still 1 — cached
            assert.strictEqual(next.mock.calls.length, 2);
        });
    });

    describe("Header propagation through full chain", () => {
        it("should propagate gateway auth headers to downstream", async () => {
            const gatewayAuth = createGatewayAuthInterceptor({
                headerMapping: {
                    subject: "x-user-id",
                    name: "x-user-name",
                    roles: "x-user-roles",
                },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["test-secret"],
                },
                propagateHeaders: true,
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "test-secret");
            headers.set("x-user-id", "prop-user");
            headers.set("x-user-name", "Prop User");
            headers.set("x-user-roles", '["admin"]');
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = gatewayAuth(next as any);
            await handler(req);

            // Standard auth headers should be set for downstream
            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "prop-user");
            assert.strictEqual(req.header.get(AUTH_HEADERS.NAME), "Prop User");
            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), JSON.stringify(["admin"]));
            assert.strictEqual(req.header.get(AUTH_HEADERS.TYPE), "gateway");
        });

        it("should propagate session auth headers with name", async () => {
            const sessionAuth = createSessionAuthInterceptor({
                verifySession: async () => ({
                    user: { id: "s-user", name: "Session Name" },
                }),
                mapSession: (session: unknown) => {
                    const s = session as { user: { id: string; name: string } };
                    return {
                        subject: s.user.id,
                        name: s.user.name,
                        roles: ["user"],
                        scopes: [],
                        claims: {},
                        type: "session",
                    };
                },
                propagateHeaders: true,
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer token");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = sessionAuth(next as any);
            await handler(req);

            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "s-user");
            assert.strictEqual(req.header.get(AUTH_HEADERS.NAME), "Session Name");
            assert.strictEqual(req.header.get(AUTH_HEADERS.TYPE), "session");
        });
    });
});
