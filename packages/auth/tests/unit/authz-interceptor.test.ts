/**
 * Unit tests for the authorization interceptor
 *
 * Tests createAuthzInterceptor() for rule evaluation, default policies,
 * role/scope checking, skip patterns, and programmatic authorization.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { authContextStorage } from "../../src/context.ts";
import type { AuthContext, AuthzRule } from "../../src/types.ts";
import { AuthzEffect } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

const defaultContext: AuthContext = {
    subject: "user-1",
    roles: ["admin"],
    scopes: ["read"],
    claims: {},
    type: "test",
};

describe("authz-interceptor", () => {
    describe("createAuthzInterceptor()", () => {
        it("should deny by default when no rules match (defaultPolicy: deny)", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied, "default policy");
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should allow when defaultPolicy is allow", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.ALLOW,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should evaluate rules in order (first match wins)", async () => {
            const rules: AuthzRule[] = [
                { name: "deny-all", methods: ["*"], effect: AuthzEffect.DENY },
                { name: "allow-all", methods: ["*"], effect: AuthzEffect.ALLOW },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.ALLOW,
                rules,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as ConnectError).code, Code.PermissionDenied);
                    assert.ok((err as Error).message.includes("deny-all"));
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    return true;
                },
            );
        });

        it("should check role requirements (any-of matching)", async () => {
            const rules: AuthzRule[] = [
                {
                    name: "admin-only",
                    methods: ["*"],
                    effect: AuthzEffect.ALLOW,
                    requires: { roles: ["admin", "superadmin"] },
                },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules,
            });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            // User has "admin" role -> should match (any-of)
            const adminContext: AuthContext = { ...defaultContext, roles: ["admin"] };
            await authContextStorage.run(adminContext, () => handler(req));
            assert.strictEqual(next.mock.calls.length, 1);

            // User without required role -> should be denied by default policy
            const viewerContext: AuthContext = { ...defaultContext, roles: ["viewer"] };
            const next2 = createMockNext();
            const handler2 = interceptor(next2);
            const req2 = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => authContextStorage.run(viewerContext, () => handler2(req2)),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next2.mock.calls.length, 0, "a caller without a required role must not reach the handler");

            // Any one of the listed roles is enough, wherever it sits in the list; no role at all is not.
            for (const roles of [["superadmin"], ["viewer", "superadmin"]]) {
                const nextN = createMockNext();
                await authContextStorage.run({ ...defaultContext, roles }, () => interceptor(nextN)(createMockRequest(MOCK_REQUEST_DEFAULTS)));
                assert.strictEqual(nextN.mock.calls.length, 1, `roles ${JSON.stringify(roles)} satisfy any-of`);
            }
            const nextEmpty = createMockNext();
            await assert.rejects(
                () => authContextStorage.run({ ...defaultContext, roles: [] }, () => interceptor(nextEmpty)(createMockRequest(MOCK_REQUEST_DEFAULTS))),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(nextEmpty.mock.calls.length, 0);
        });

        // The guide: "A rule whose role or scope requirements fail is skipped; it does not deny the
        // request by itself." A deny rule with requirements therefore denies exactly the callers who
        // satisfy them, and everyone else falls through to the next rule.
        it("should skip a deny rule whose requirements are not met instead of denying", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [
                    { name: "block-banned", methods: ["*"], effect: AuthzEffect.DENY, requires: { roles: ["banned"] } },
                    { name: "allow-members", methods: ["*"], effect: AuthzEffect.ALLOW, requires: { roles: ["member"] } },
                ],
            });

            // A member who is not banned skips the deny rule and is allowed by the next one.
            const nextMember = createMockNext();
            await authContextStorage.run({ ...defaultContext, roles: ["member"] }, () => interceptor(nextMember)(createMockRequest(MOCK_REQUEST_DEFAULTS)));
            assert.strictEqual(nextMember.mock.calls.length, 1);

            // A banned member satisfies the deny rule and is refused by it, naming that rule.
            const nextBanned = createMockNext();
            await assert.rejects(
                () => authContextStorage.run({ ...defaultContext, roles: ["member", "banned"] }, () => interceptor(nextBanned)(createMockRequest(MOCK_REQUEST_DEFAULTS))),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as ConnectError).code, Code.PermissionDenied);
                    assert.strictEqual(err.name, "AuthzDeniedError");
                    assert.ok(err.message.includes("block-banned"), err.message);
                    return true;
                },
            );
            assert.strictEqual(nextBanned.mock.calls.length, 0);
        });

        it("should check scope requirements (all-of matching)", async () => {
            const rules: AuthzRule[] = [
                {
                    name: "read-write",
                    methods: ["*"],
                    effect: AuthzEffect.ALLOW,
                    requires: { scopes: ["read", "write"] },
                },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules,
            });

            // User has both scopes -> should be allowed
            const fullContext: AuthContext = { ...defaultContext, scopes: ["read", "write", "delete"] };
            const next1 = createMockNext();
            const handler1 = interceptor(next1);
            const req1 = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await authContextStorage.run(fullContext, () => handler1(req1));
            assert.strictEqual(next1.mock.calls.length, 1);

            // User missing "write" scope -> denied by default policy
            const readOnlyContext: AuthContext = { ...defaultContext, scopes: ["read"] };
            const next2 = createMockNext();
            const handler2 = interceptor(next2);
            const req2 = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => authContextStorage.run(readOnlyContext, () => handler2(req2)),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next2.mock.calls.length, 0);

            // All-of is symmetric: holding only the second required scope is not enough either.
            const writeOnlyNext = createMockNext();
            await assert.rejects(
                () => authContextStorage.run({ ...defaultContext, scopes: ["write"] }, () => interceptor(writeOnlyNext)(createMockRequest(MOCK_REQUEST_DEFAULTS))),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(writeOnlyNext.mock.calls.length, 0);
        });

        it("should require both the roles and the scopes of one rule when it lists both", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [{ name: "admin-writer", methods: ["*"], effect: AuthzEffect.ALLOW, requires: { roles: ["admin"], scopes: ["write"] } }],
            });
            const run = async (context: AuthContext) => {
                const next = createMockNext();
                await authContextStorage.run(context, () => interceptor(next)(createMockRequest(MOCK_REQUEST_DEFAULTS)));
                return next.mock.calls.length;
            };

            assert.strictEqual(await run({ ...defaultContext, roles: ["admin"], scopes: ["write"] }), 1);
            // Roles satisfied, scopes not; scopes satisfied, roles not: each half alone is refused.
            for (const context of [
                { ...defaultContext, roles: ["admin"], scopes: ["read"] },
                { ...defaultContext, roles: ["viewer"], scopes: ["write"] },
            ]) {
                await assert.rejects(
                    () => run(context),
                    (err: unknown) => {
                        assertConnectError(err, Code.PermissionDenied);
                        return true;
                    },
                );
            }
        });

        it("should skip authz only for the methods listed in skipMethods", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
                skipMethods: ["test.Service/Method", "wild.Service/*"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            // No AuthContext set, but the method is skipped so no error: exact entry and service wildcard.
            await handler(createMockRequest(MOCK_REQUEST_DEFAULTS));
            await handler(createMockRequest({ service: "wild.Service", method: "Anything" }));
            assert.strictEqual(next.mock.calls.length, 2);

            // Everything else still needs an authenticated caller.
            for (const other of [
                { service: "test.Service", method: "OtherMethod" },
                { service: "other.Service", method: "Method" },
                { service: "wild.ServiceX", method: "Anything" },
            ]) {
                await assert.rejects(
                    () => handler(createMockRequest(other)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                    `${other.service}/${other.method} must not be skipped`,
                );
            }
            assert.strictEqual(next.mock.calls.length, 2);
        });

        it("should call programmatic authorize callback when no rules match", async () => {
            const authorize = mock.fn(
                async (context: AuthContext, _req: { service: string; method: string }) => {
                    return context.roles.includes("admin");
                },
            );

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
                authorize: authorize as any,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(authorize.mock.calls.length, 1);
            assert.strictEqual(next.mock.calls.length, 1);

            // Verify the callback receives correct arguments
            const callArgs = authorize.mock.calls[0]!.arguments;
            assert.strictEqual(callArgs[0].subject, "user-1");
            assert.strictEqual(callArgs[1].service, "test.Service");
            assert.strictEqual(callArgs[1].method, "Method");
        });

        // The guide: if `authorize` returns false the request fails with PermissionDenied, including
        // when defaultPolicy is allow; the default policy applies only when no rule matches and no
        // callback is configured.
        for (const defaultPolicy of [AuthzEffect.DENY, AuthzEffect.ALLOW]) {
            it(`should refuse with PermissionDenied when authorize returns false (defaultPolicy ${defaultPolicy})`, async () => {
                const authorize = mock.fn(async () => false);
                const interceptor = createAuthzInterceptor({ defaultPolicy, rules: [], authorize });
                const next = createMockNext();
                const handler = interceptor(next);

                await assert.rejects(
                    () => authContextStorage.run(defaultContext, () => handler(createMockRequest(MOCK_REQUEST_DEFAULTS))),
                    (err: unknown) => {
                        assertConnectError(err, Code.PermissionDenied);
                        return true;
                    },
                );
                assert.strictEqual(authorize.mock.calls.length, 1);
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

        it("should not consult authorize when a rule already decided the request", async () => {
            const authorize = mock.fn(async () => false);
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [{ name: "allow-all", methods: ["*"], effect: AuthzEffect.ALLOW }],
                authorize,
            });
            const next = createMockNext();

            await authContextStorage.run(defaultContext, () => interceptor(next)(createMockRequest(MOCK_REQUEST_DEFAULTS)));

            assert.strictEqual(authorize.mock.calls.length, 0, "a matching rule makes the callback unnecessary");
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should not consult authorize for a skipped method", async () => {
            const authorize = mock.fn(async () => false);
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
                authorize,
                skipMethods: ["test.Service/Method"],
            });
            const next = createMockNext();

            await interceptor(next)(createMockRequest(MOCK_REQUEST_DEFAULTS));

            assert.strictEqual(authorize.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should throw Unauthenticated when no AuthContext available", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Authentication required");
                    return true;
                },
            );
        });
    });
});
