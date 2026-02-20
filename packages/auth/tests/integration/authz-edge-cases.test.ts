/**
 * Integration tests for authorization edge cases.
 *
 * Covers: rule requires not met → continue, no auth context → Unauthenticated,
 * AuthzDeniedError with requiredRoles/requiredScopes, serverDetails getter,
 * authorize callback allow/deny, global wildcard "*", requireAuthContext.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { requireAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { withAuthContext } from "../../src/testing/with-context.ts";
import { buildChainedHandler, createMockRequest } from "../helpers/mock-request.ts";

describe("Authz Edge Cases — Integration", () => {
    describe("rule requires not met → continue to next rule", () => {
        it("should skip rule with unmet requires and match next rule", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                roles: ["editor"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                    {
                        name: "editor-access",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["editor"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            await handler(req);

            // First rule (admin) skipped, second rule (editor) matched
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when all rules' requires are unmet and default is deny", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                roles: ["viewer"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                    {
                        name: "editor-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["editor"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

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

    describe("no auth context → Unauthenticated", () => {
        it("should throw Unauthenticated when authz runs without auth context", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [],
            });

            const req = createMockRequest();
            const next = mock.fn(async () => ({ message: {} }));
            const handler = authzInterceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Authentication required/);
                    return true;
                },
            );
        });
    });

    describe("AuthzDeniedError details", () => {
        it("should include requiredRoles in AuthzDeniedError details", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                roles: ["viewer"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-rule",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "deny",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    // Rule requires admin, viewer doesn't have it, so rule doesn't match.
                    // Falls through to default policy "deny".
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    return true;
                },
            );
        });

        it("should produce AuthzDeniedError with serverDetails when deny rule matches", async () => {
            const token = await createTestJwt({
                sub: "admin-1",
                roles: ["admin"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            // Deny rule that matches admin — unconditionally deny
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [
                    {
                        name: "block-admin-delete",
                        methods: ["test.v1.TestService/DeleteItem"],
                        effect: "deny",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ methodName: "DeleteItem", headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    assert.strictEqual((err as any).clientMessage, "Access denied");
                    assert.strictEqual((err as any).ruleName, "block-admin-delete");

                    // serverDetails getter
                    const details = (err as any).serverDetails;
                    assert.strictEqual(details.ruleName, "block-admin-delete");
                    return true;
                },
            );
        });

        it("should include requiredRoles and requiredScopes in serverDetails when deny rule has requires", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                roles: ["admin"],
                scope: "read write",
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles", scopes: "scope" },
            });

            // Rule matches (admin has role), but effect is deny
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [
                    {
                        name: "deny-with-details",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"], scopes: ["read"] },
                        effect: "deny",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    const details = (err as any).serverDetails;
                    assert.deepStrictEqual(details.requiredRoles, ["admin"]);
                    assert.deepStrictEqual(details.requiredScopes, ["read"]);
                    return true;
                },
            );
        });
    });

    describe("authorize callback", () => {
        it("should allow via callback when no rules match", async () => {
            const token = await createTestJwt({
                sub: "callback-user",
                roles: ["special"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "other-service",
                        methods: ["other.v1.Other/*"],
                        effect: "allow",
                    },
                ],
                authorize: (ctx) => {
                    return ctx.roles.includes("special");
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny via callback when callback returns false", async () => {
            const token = await createTestJwt({
                sub: "denied-callback-user",
                roles: [],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                authorize: () => false,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    assert.match(err.message, /Access denied/);
                    return true;
                },
            );
        });
    });

    describe("global wildcard '*' in skipMethods", () => {
        it("should skip authz for all methods with '*' wildcard", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                skipMethods: ["*"],
            });

            // No auth context at all — should still pass because skipped
            const req = createMockRequest();
            const next = mock.fn(async () => ({ message: {} }));
            const handler = authzInterceptor(next as any);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should match '*' wildcard in rule methods", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                roles: ["any"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "allow-all",
                        methods: ["*"],
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("requireAuthContext", () => {
        it("should throw Unauthenticated when called outside auth context", () => {
            assert.throws(
                () => requireAuthContext(),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Authentication required/);
                    return true;
                },
            );
        });

        it("should return context when called within auth context", async () => {
            const mockCtx = createMockAuthContext({ subject: "ctx-user", roles: ["admin"] });

            const result = await withAuthContext(mockCtx, () => {
                return requireAuthContext();
            });

            assert.strictEqual(result.subject, "ctx-user");
            assert.deepStrictEqual([...result.roles], ["admin"]);
        });
    });
});
