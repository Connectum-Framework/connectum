/**
 * Integration tests for Gateway and Session auth interceptors
 *
 * Tests the full chain: gateway/session authentication followed by
 * authorization and header propagation.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.v1.TestService", method: "TestMethod" } as const;

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = gatewayAuth(authz(next as any) as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
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
            const req1 = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers: headers1 });

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
            const req2 = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers: headers2 });
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
                    scopes: "x-user-scopes",
                    claims: "x-user-claims",
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
            headers.set("x-user-scopes", "read write");
            headers.set("x-user-claims", '{"tenant":"acme"}');
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            // Guide: the gateway's own headers and the trust header are deleted, and the verified
            // identity is written back under the standard x-auth-* names (not the trust secret).
            // The downstream handler's view is what matters, so it is captured inside next().
            let seen: Record<string, string> = {};
            const next = mock.fn(async (r: { header: Headers }) => {
                seen = Object.fromEntries(r.header);
                return { message: {} };
            });
            const handler = gatewayAuth(next as any);
            await handler(req);

            assert.deepStrictEqual(seen, {
                "x-auth-subject": "prop-user",
                "x-auth-type": "gateway",
                "x-auth-name": "Prop User",
                "x-auth-roles": '["admin"]',
                "x-auth-scopes": "read write",
                "x-auth-claims": '{"tenant":"acme"}',
            });
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
                        scopes: ["profile", "email"],
                        claims: { org_id: "org-7", email: "s@example.com", secret: "hide-me" },
                        type: "session",
                    };
                },
                propagateHeaders: true,
                // Guide: propagatedClaims filters which claims are written into x-auth-claims.
                propagatedClaims: ["org_id", "email"],
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer token");
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            let seen: Record<string, string> = {};
            const next = mock.fn(async (r: { header: Headers }) => {
                seen = Object.fromEntries(r.header);
                return { message: {} };
            });
            const handler = sessionAuth(next as any);
            await handler(req);

            assert.deepStrictEqual(seen, {
                authorization: "Bearer token",
                "x-auth-subject": "s-user",
                "x-auth-type": "session",
                "x-auth-name": "Session Name",
                "x-auth-roles": '["user"]',
                "x-auth-scopes": "profile email",
                "x-auth-claims": '{"org_id":"org-7","email":"s@example.com"}',
            });
        });
    });
});
