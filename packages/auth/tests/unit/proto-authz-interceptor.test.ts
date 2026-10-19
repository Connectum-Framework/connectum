/**
 * Unit tests for the proto-based authorization interceptor.
 *
 * Tests createProtoAuthzInterceptor() for proto option reading,
 * public method bypass, role/scope checking, policy enforcement,
 * fallback to programmatic rules, and default policy behavior.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext } from "@connectum/testing";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext, AuthzRule } from "../../src/types.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest, createServiceOptions } from "../helpers/proto-test-helpers.ts";

const defaultContext: AuthContext = {
    subject: "user-1",
    roles: ["admin"],
    scopes: ["read", "write"],
    claims: {},
    type: "test",
};

describe("proto-authz-interceptor", () => {
    describe("createProtoAuthzInterceptor()", () => {
        it("should skip auth for public method (proto option)", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PublicMethod", createMethodOptions({ public: true }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // No auth context — should still pass because method is public
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should allow when user has required role", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AdminOnly", createMethodOptions({ requires: { roles: ["admin"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when user lacks required role", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AdminOnly", createMethodOptions({ requires: { roles: ["superadmin"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            const viewerContext: AuthContext = { ...defaultContext, roles: ["viewer"] };

            await assert.rejects(
                () => authContextStorage.run(viewerContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should allow when user has all required scopes (all-of)", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ScopedMethod", createMethodOptions({ requires: { scopes: ["read", "write"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when user is missing a required scope", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ScopedMethod", createMethodOptions({ requires: { scopes: ["read", "delete"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // User has "read", "write" but not "delete"
            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });

        it("should allow when proto policy is 'allow'", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AllowedMethod", createMethodOptions({ policy: "allow" }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when proto policy is 'deny'", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "DeniedMethod", createMethodOptions({ policy: "deny" }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });

        it("should fallback to programmatic rules when no proto options", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "FallbackMethod");

            const rules: AuthzRule[] = [
                {
                    name: "allow-admin",
                    methods: ["test.v1.TestService/*"],
                    requires: { roles: ["admin"] },
                    effect: "allow",
                },
            ];

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", rules });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should fallback to authorize callback when no proto options and no rules match", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "CallbackMethod");

            const authorize = mock.fn(async (ctx: AuthContext) => ctx.roles.includes("admin"));

            const interceptor = createProtoAuthzInterceptor({
                defaultPolicy: "deny",
                authorize: authorize as any,
            });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(authorize.mock.calls.length, 1);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should apply defaultPolicy when no proto options, no rules, no callback", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "DefaultMethod");

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied, "default policy");
                    return true;
                },
            );
        });

        it("should throw Unauthenticated when no auth context on non-public method", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ProtectedMethod", createMethodOptions({ requires: { roles: ["admin"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should allow with defaultPolicy: allow when no config at all", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "OpenMethod");

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        // Documented in the guide's decision flow: the first method-matching rule without `requires`
        // matches unconditionally, even without context (the method-mismatch and deny counterparts
        // are covered in the "fallback rules" group).
        it("should allow via unconditional rule without auth context", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PublicFallback");

            const rules: AuthzRule[] = [
                { name: "public-access", methods: ["test.v1.TestService/PublicFallback"], effect: "allow" },
            ];

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", rules });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // No auth context — should pass because rule has no requires
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should throw Unauthenticated when no auth context and no matching unconditional rule", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ProtectedFallback");

            const rules: AuthzRule[] = [
                { name: "admin-only", methods: ["test.v1.TestService/*"], requires: { roles: ["admin"] }, effect: "allow" },
            ];

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", rules });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // No auth context, rule has requires → skipped, falls to defaultPolicy deny → Unauthenticated
            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should deny via fallback rule effect: deny", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "BlockedMethod");

            const rules: AuthzRule[] = [{ name: "block-all", methods: ["*"], effect: "deny" }];

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", rules });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });
    });

    // The guide's decision flow, stage "programmatic rules": the first method-matching rule without
    // `requires` matches unconditionally, even without an auth context; a rule with `requires` is
    // skipped when its requirements fail; a matching deny rule refuses.
    describe("fallback rules (decision flow)", () => {
        const roleRule = (effect: "allow" | "deny", role: string): AuthzRule => ({
            name: `${effect}-${role}`,
            methods: ["test.v1.TestService/*"],
            requires: { roles: [role] },
            effect,
        });

        it("should skip a fallback rule whose requirements are not met and apply defaultPolicy", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "FallbackMethod");
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", rules: [roleRule("allow", "superadmin")] });
            const next = createMockNext();

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => interceptor(next)(createProtoMockRequest(service, method))),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied, "default policy");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should apply a fallback deny rule with requirements only to callers who satisfy them", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "FallbackMethod");
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", rules: [roleRule("deny", "banned")] });

            // Not banned: the deny rule is skipped and the allow default applies.
            const nextOk = createMockNext();
            await authContextStorage.run(defaultContext, () => interceptor(nextOk)(createProtoMockRequest(service, method)));
            assert.strictEqual(nextOk.mock.calls.length, 1);

            // Banned: the deny rule matches and refuses.
            const nextBanned = createMockNext();
            await assert.rejects(
                () => authContextStorage.run({ ...defaultContext, roles: ["banned"] }, () => interceptor(nextBanned)(createProtoMockRequest(service, method))),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.name, "AuthzDeniedError");
                    assert.strictEqual((err as { code?: unknown }).code, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(nextBanned.mock.calls.length, 0);
        });

        it("should not apply a fallback rule written for a different method", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "FallbackMethod");
            const rules: AuthzRule[] = [{ name: "other-method", methods: ["test.v1.TestService/SomethingElse", "other.v1.OtherService/*"], effect: "allow" }];
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", rules });
            const next = createMockNext();

            await assert.rejects(
                () => interceptor(next)(createProtoMockRequest(service, method)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should refuse with a matching unconditional deny rule even without an auth context", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "FallbackMethod");
            const rules: AuthzRule[] = [{ name: "block-all", methods: ["test.v1.TestService/FallbackMethod"], effect: "deny" }];
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", rules });
            const next = createMockNext();

            await assert.rejects(
                () => interceptor(next)(createProtoMockRequest(service, method)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.name, "AuthzDeniedError");
                    assert.strictEqual((err as { code?: unknown }).code, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });
    });

    // The guide's decision flow, stage "authorize callback": it receives the context and the method,
    // `false` is PermissionDenied and is terminal (defaultPolicy is not consulted afterwards), a
    // missing context is Unauthenticated, and an earlier decision makes the callback unnecessary.
    describe("authorize callback (decision flow)", () => {
        it("should pass the auth context and the called method to authorize", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "CallbackMethod");
            const authorize = mock.fn(async (_ctx: AuthContext, _req: { service: string; method: string }) => true);
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny", authorize });

            await authContextStorage.run(defaultContext, () => interceptor(createMockNext())(createProtoMockRequest(service, method)));

            assert.strictEqual(authorize.mock.calls.length, 1);
            const [ctx, called] = authorize.mock.calls[0]!.arguments;
            assert.strictEqual(ctx.subject, "user-1");
            assert.deepStrictEqual(called, { service: "test.v1.TestService", method: "CallbackMethod" });
        });

        for (const defaultPolicy of ["deny", "allow"] as const) {
            it(`should refuse with PermissionDenied when authorize returns false (defaultPolicy ${defaultPolicy})`, async () => {
                const service = createFakeService();
                const method = createFakeMethod(service, "CallbackMethod");
                const authorize = mock.fn(async () => false);
                const interceptor = createProtoAuthzInterceptor({ defaultPolicy, authorize });
                const next = createMockNext();

                await assert.rejects(
                    () => authContextStorage.run(defaultContext, () => interceptor(next)(createProtoMockRequest(service, method))),
                    (err: unknown) => {
                        assertConnectError(err, Code.PermissionDenied);
                        return true;
                    },
                );
                assert.strictEqual(authorize.mock.calls.length, 1);
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

        it("should throw Unauthenticated without calling authorize when there is no auth context", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "CallbackMethod");
            const authorize = mock.fn(async () => true);
            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", authorize });
            const next = createMockNext();

            await assert.rejects(
                () => interceptor(next)(createProtoMockRequest(service, method)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(authorize.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should not call authorize when a proto option or a rule already decided", async () => {
            const authorize = mock.fn(async () => false);
            const service = createFakeService();

            const protoMethod = createFakeMethod(service, "ProtoDecided", createMethodOptions({ policy: "allow" }));
            const nextProto = createMockNext();
            await authContextStorage.run(defaultContext, () => createProtoAuthzInterceptor({ authorize })(nextProto)(createProtoMockRequest(service, protoMethod)));
            assert.strictEqual(nextProto.mock.calls.length, 1);

            const ruleMethod = createFakeMethod(service, "RuleDecided");
            const rules: AuthzRule[] = [{ name: "allow-all", methods: ["*"], effect: "allow" }];
            const nextRule = createMockNext();
            await authContextStorage.run(defaultContext, () => createProtoAuthzInterceptor({ authorize, rules })(nextRule)(createProtoMockRequest(service, ruleMethod)));
            assert.strictEqual(nextRule.mock.calls.length, 1);

            assert.strictEqual(authorize.mock.calls.length, 0);
        });
    });

    // An empty list places no restriction on its dimension, and `requires {}` asks only
    // for an authenticated caller. An unauthenticated caller is turned away either way.
    describe("empty requires lists", () => {
        const noRoles: AuthContext = { subject: "plain", roles: [], scopes: [], claims: {}, type: "test" };

        async function call(requires: { roles?: string[]; scopes?: string[] }, context: AuthContext | undefined) {
            const service = createFakeService();
            const method = createFakeMethod(service, "Gated", createMethodOptions({ requires }));
            const next = createMockNext();
            const handler = createProtoAuthzInterceptor({ defaultPolicy: "deny" })(next);
            const req = createProtoMockRequest(service, method);
            const run = () => handler(req);
            try {
                await (context ? authContextStorage.run(context, run) : run());
                return { admitted: next.mock.calls.length === 1, error: undefined as unknown };
            } catch (error) {
                return { admitted: false, error };
            }
        }

        it("requires { roles: [] } admits an authenticated caller who has no roles", async () => {
            assert.strictEqual((await call({ roles: [] }, noRoles)).admitted, true);
        });

        it("requires {} admits an authenticated caller", async () => {
            assert.strictEqual((await call({}, noRoles)).admitted, true);
        });

        it("requires {} rejects a caller without an identity as Unauthenticated", async () => {
            const result = await call({}, undefined);
            assert.strictEqual(result.admitted, false);
            assertConnectError(result.error, Code.Unauthenticated);
        });

        it("requires { roles: [] } rejects a caller without an identity as Unauthenticated", async () => {
            const result = await call({ roles: [] }, undefined);
            assert.strictEqual(result.admitted, false);
            assertConnectError(result.error, Code.Unauthenticated);
        });

        it("requires { roles: [admin], scopes: [] } still denies a caller without the role", async () => {
            const result = await call({ roles: ["admin"], scopes: [] }, noRoles);
            assert.strictEqual(result.admitted, false);
            assert.ok(result.error instanceof Error);
            assert.strictEqual(result.error.name, "AuthzDeniedError");
            assert.strictEqual((result.error as { code?: Code }).code, Code.PermissionDenied);
        });

        it("requires { roles: [], scopes: [read] } still denies a caller without the scope", async () => {
            const result = await call({ roles: [], scopes: ["read"] }, noRoles);
            assert.strictEqual(result.admitted, false);
            assert.ok(result.error instanceof Error);
            assert.strictEqual(result.error.name, "AuthzDeniedError");
            assert.strictEqual((result.error as { code?: Code }).code, Code.PermissionDenied);
        });
    });

    // A contract that cannot be resolved must stop the call, not fall through to a default.
    describe("invalid proto configuration", () => {
        it("refuses a method whose policy is misspelled, even under defaultPolicy allow", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "Typo", createMethodOptions({ policy: "dney" }));
            const next = createMockNext();
            const handler = createProtoAuthzInterceptor({ defaultPolicy: "allow" })(next);

            await assert.rejects(() => authContextStorage.run(defaultContext, () => handler(createProtoMockRequest(service, method))), /"dney"/);
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("refuses a method marked both public and internal instead of letting public win", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "Both", createMethodOptions({ public: true, internal: true }));
            const next = createMockNext();
            const handler = createProtoAuthzInterceptor({ defaultPolicy: "deny" })(next);

            await assert.rejects(() => handler(createProtoMockRequest(service, method)), /public: true, internal: false/);
            assert.strictEqual(next.mock.calls.length, 0);
        });
    });

    // ADR-029: internal (service-to-service) methods compose inclusively with
    // the existing authz model. The internal identity is populated upstream by
    // createInternalAuthInterceptor; here we simulate it via authContextStorage.run.
    describe("internal methods (ADR-029)", () => {
        const internalContext: AuthContext = {
            subject: "trips-service",
            roles: ["worker"],
            scopes: [],
            claims: {},
            type: "service",
        };

        it("allows an internal method with no requires when identity is present", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(internalContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("rejects an internal method with no identity as Unauthenticated", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // No authContextStorage.run -> no identity.
            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("inclusive roles: internal + requires{roles} ALLOWS a caller with the role (existing requires path)", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true, requires: { roles: ["worker"] } }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(internalContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("inclusive roles: internal + requires{roles} DENIES a caller without the role (PermissionDenied)", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true, requires: { roles: ["admin"] } }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            // internalContext has role "worker", not "admin".
            await assert.rejects(
                () => authContextStorage.run(internalContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("internal resolved from service-level default (method inherits service internal)", async () => {
            const service = createFakeService({ serviceOptions: createServiceOptions({ internal: true }) });
            const method = createFakeMethod(service, "RecordTrip");

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createProtoMockRequest(service, method);

            await authContextStorage.run(internalContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });
});
