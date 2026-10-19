/**
 * Integration tests for authorization edge cases.
 *
 * Covers: rule requires not met → continue, no auth context → Unauthenticated,
 * AuthzDeniedError with requiredRoles/requiredScopes, serverDetails getter,
 * authorize callback allow/deny, global wildcard "*", requireAuthContext.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { requireAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createInternalAuthInterceptor } from "../../src/internal-auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { withAuthContext } from "../../src/testing/with-context.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.v1.TestService", method: "TestMethod" } as const;

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
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
                    assertConnectError(err, Code.Unauthenticated, /Authentication required/);
                    return true;
                },
            );
        });
    });

    describe("AuthzDeniedError details", () => {
        // A deny rule whose requirements are not met does not match (guide: a rule applies only
        // when the caller satisfies its requires), so the outcome is decided by the default policy.
        // The pair of cases separates "default policy decides" from "the unmet deny rule denies anyway".
        it("should not apply a deny rule whose requirements are unmet: defaultPolicy allow lets the caller through", async () => {
            const token = await createTestJwt({ sub: "user-1", roles: ["viewer"] });
            const authInterceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, claimsMapping: { roles: "roles" } });
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [{ name: "admin-rule", methods: ["test.v1.TestService/*"], requires: { roles: ["admin"] }, effect: "deny" }],
            });
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers: new Headers({ authorization: `Bearer ${token}` }) });
            const next = mock.fn(async () => ({ message: {} }));

            await buildChainedHandler(authInterceptor, authzInterceptor, next)(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should fall back to defaultPolicy deny when a deny rule's requirements are unmet", async () => {
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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    // Rule requires admin, viewer doesn't have it, so rule doesn't match.
                    // Falls through to default policy "deny".
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, method: "DeleteItem", headers });

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        // Оракул: guide/auth/authorization.md (раздел Programmatic Callback) -- результат
        // колбэка окончателен: false даёт PermissionDenied, в том числе при defaultPolicy
        // allow, true пропускает запрос, в том числе при defaultPolicy deny; политика по
        // умолчанию применяется только когда ни одно правило не сработало и колбэка нет.
        // Поэтому проверяются обе политики: исход обязан определяться колбэком, а не политикой.
        for (const defaultPolicy of ["allow", "deny"] as const) {
            it(`should deny via callback when callback returns false (defaultPolicy ${defaultPolicy})`, async () => {
                const token = await createTestJwt({
                    sub: "denied-callback-user",
                    roles: [],
                });

                const authInterceptor = createJwtAuthInterceptor({
                    secret: TEST_JWT_SECRET,
                    claimsMapping: { roles: "roles" },
                });

                const authzInterceptor = createAuthzInterceptor({
                    defaultPolicy,
                    authorize: () => false,
                });

                const headers = new Headers();
                headers.set("authorization", `Bearer ${token}`);
                const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

                const next = mock.fn(async () => ({ message: {} }));
                const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

                await assert.rejects(
                    () => handler(req),
                    (err: unknown) => {
                        // Сообщение колбэка, а не "Access denied by default policy":
                        // отказ принят колбэком, не политикой.
                        assertConnectError(err, Code.PermissionDenied, /Access denied$/);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
            });

            it(`should allow via callback when callback returns true (defaultPolicy ${defaultPolicy})`, async () => {
                const token = await createTestJwt({
                    sub: "allowed-callback-user",
                    roles: [],
                });

                const authInterceptor = createJwtAuthInterceptor({
                    secret: TEST_JWT_SECRET,
                    claimsMapping: { roles: "roles" },
                });

                const authzInterceptor = createAuthzInterceptor({
                    defaultPolicy,
                    authorize: () => true,
                });

                const headers = new Headers();
                headers.set("authorization", `Bearer ${token}`);
                const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

                const next = mock.fn(async () => ({ message: {} }));
                const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

                await handler(req);
                assert.strictEqual(next.mock.calls.length, 1);
            });
        }
    });

    describe("catch-all '*' pattern", () => {
        // `skipMethods: ["*"]` switches an interceptor off for every method without saying so,
        // so every factory with a skipMethods option refuses it at creation. The message names
        // the way out: do not register the interceptor, or list Service/* patterns.
        const factories: Array<[string, (skipMethods: string[]) => unknown]> = [
            ["createAuthInterceptor", (skipMethods) => createAuthInterceptor({ verifyCredentials: async () => createMockAuthContext(), skipMethods })],
            ["createJwtAuthInterceptor", (skipMethods) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, skipMethods })],
            ["createSessionAuthInterceptor", (skipMethods) => createSessionAuthInterceptor({ verifySession: async () => ({}), mapSession: async () => createMockAuthContext(), skipMethods })],
            [
                "createGatewayAuthInterceptor",
                (skipMethods) => createGatewayAuthInterceptor({ headerMapping: { subject: "x-user" }, trustSource: { header: "x-gateway", expectedValues: ["secret"] }, skipMethods }),
            ],
            ["createAuthzInterceptor", (skipMethods) => createAuthzInterceptor({ defaultPolicy: "deny", skipMethods })],
        ];

        for (const [name, create] of factories) {
            it(`${name} should refuse skipMethods ["*"] with a message naming the way out`, () => {
                assert.throws(
                    () => create(["*"]),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.ok(err.message.includes('skipMethods must not contain the catch-all pattern "*"'), err.message);
                        assert.ok(err.message.includes("do not register it"), err.message);
                        assert.ok(err.message.includes("Service/*"), err.message);
                        return true;
                    },
                );
            });

            it(`${name} should refuse "*" even next to other patterns`, () => {
                assert.throws(() => create(["pkg.v1.Svc/Method", "*"]), /catch-all pattern "\*"/);
            });

            it(`${name} should accept a Service/* pattern and an exact method`, () => {
                assert.doesNotThrow(() => create(["pkg.v1.Svc/*", "pkg.v1.Other/Method"]));
            });
        }

        it("should still skip the whole service for a Service/* pattern in skipMethods", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                skipMethods: ["test.v1.TestService/*"],
            });

            // No auth context at all — passes only because the service is skipped
            const next = mock.fn(async () => ({ message: {} }));
            await authzInterceptor(next as any)(createMockRequest({ service: "test.v1.TestService", method: "AnyMethod" }));
            assert.strictEqual(next.mock.calls.length, 1);

            // A method of another service is not skipped
            const other = mock.fn(async () => ({ message: {} }));
            await assert.rejects(() => authzInterceptor(other as any)(createMockRequest({ service: "other.v1.OtherService", method: "TestMethod" })));
            assert.strictEqual(other.mock.calls.length, 0);
        });

        it("should keep '*' valid in internalMethods of the internal interceptor", async () => {
            const interceptor = createInternalAuthInterceptor({ internalMethods: ["*"], trustSource: () => null });
            const next = mock.fn(async () => ({ message: {} }));
            await assert.rejects(() => interceptor(next as any)(createMockRequest()), (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated);
                return true;
            });
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // Guide, "Method Patterns": '*' matches all services and methods, and a rule without
        // requires matches every authenticated caller. Three different services and methods are
        // allowed by one rule; an exact-method rule on another method is the control that
        // shows the allowance comes from '*' and not from a default.
        it("should let a '*' rule match every service and method for an authenticated caller", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [{ name: "allow-all", methods: ["*"], effect: "allow" }],
            });
            const caller = createMockAuthContext({ subject: "user-1", roles: [] });

            for (const [service, method] of [
                ["test.v1.TestService", "TestMethod"],
                ["other.v2.OtherService", "OtherMethod"],
                ["third.Service", "Another"],
            ] as const) {
                const next = mock.fn(async () => ({ message: {} }));
                await withAuthContext(caller, () => authzInterceptor(next as any)(createMockRequest({ service, method })));
                assert.strictEqual(next.mock.calls.length, 1, `${service}/${method} should be allowed`);
            }
        });

        it("should still require an authenticated caller for a '*' rule", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [{ name: "allow-all", methods: ["*"], effect: "allow" }],
            });
            const next = mock.fn(async () => ({ message: {} }));

            await assert.rejects(authzInterceptor(next as any)(createMockRequest(MOCK_REQUEST_DEFAULTS)), (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated);
                return true;
            });
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should not let an exact-method rule act as a wildcard", async () => {
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [{ name: "allow-one", methods: ["test.v1.TestService/Other"], effect: "allow" }],
            });
            const caller = createMockAuthContext({ subject: "user-1", roles: [] });
            const next = mock.fn(async () => ({ message: {} }));

            await assert.rejects(
                withAuthContext(caller, () => authzInterceptor(next as any)(createMockRequest(MOCK_REQUEST_DEFAULTS))),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
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
            const req = createMockRequest({ ...MOCK_REQUEST_DEFAULTS, headers });

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
                    assertConnectError(err, Code.Unauthenticated, /Authentication required/);
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
