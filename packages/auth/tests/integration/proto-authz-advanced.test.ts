/**
 * Integration tests for proto-based authorization advanced paths.
 *
 * Covers: proto policy allow/deny, fallback programmatic rules,
 * evaluate rules with requires not met → continue, authorize callback,
 * defaultPolicy allow, service-level defaults (reader.ts),
 * normalizePolicy unknown, getPublicMethods.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { getPublicMethods, resolveMethodAuth } from "../../src/proto/reader.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest, createServiceOptions } from "../helpers/proto-test-helpers.ts";

describe("Proto Authz Advanced — Integration", () => {
    describe("proto policy allow/deny", () => {
        it("should allow when method has policy=allow", async () => {
            const svcOpts = createServiceOptions({});
            const service = createFakeService({ serviceOptions: svcOpts });
            const allowMethod = createFakeMethod(service, "OpenAction", createMethodOptions({ policy: "allow" }));

            const token = await createTestJwt({ sub: "user-1", roles: [] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, allowMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when method has policy=deny", async () => {
            const svcOpts = createServiceOptions({});
            const service = createFakeService({ serviceOptions: svcOpts });
            const denyMethod = createFakeMethod(service, "BlockedAction", createMethodOptions({ policy: "deny" }));

            const token = await createTestJwt({ sub: "admin-1", roles: ["admin"] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow" });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, denyMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).ruleName, "proto:policy");
                    return true;
                },
            );
        });
    });

    describe("fallback programmatic rules", () => {
        it("should allow via fallback rule when no proto options match", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "FallbackAction");

            const token = await createTestJwt({ sub: "user-1", roles: ["editor"] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
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
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny via fallback rule", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "DeniedFallback");

            const token = await createTestJwt({ sub: "user-1", roles: ["viewer"] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [
                    {
                        name: "block-viewers",
                        methods: ["test.v1.TestService/*"],
                        effect: "deny",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).ruleName, "block-viewers");
                    return true;
                },
            );
        });

        it("should skip rule when requires not met and continue to next", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "RequiresCheck");

            const token = await createTestJwt({ sub: "user-1", roles: ["viewer"] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                    {
                        name: "viewer-access",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["viewer"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("authorize callback", () => {
        it("should allow via callback when no rules match", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "CallbackAction");

            const token = await createTestJwt({ sub: "special-user", roles: ["special"] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "deny",
                authorize: (ctx) => ctx.roles.includes("special"),
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny via callback", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "DeniedCallback");

            const token = await createTestJwt({ sub: "user-1", roles: [] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            // Guide, decision flow: the callback is terminal. `false` refuses the request with
            // PermissionDenied and is not followed by defaultPolicy, even when that policy is "allow".
            // The callback is also given the caller's context and the method being called.
            const authorize = mock.fn((_ctx: { subject: string }, _req: { service: string; method: string }) => false);
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "allow",
                authorize: authorize as never,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
            assert.strictEqual(authorize.mock.calls.length, 1);
            const [ctxArg, reqArg] = authorize.mock.calls[0]?.arguments ?? [];
            assert.strictEqual(ctxArg?.subject, "user-1");
            assert.deepStrictEqual(reqArg, { service: "test.v1.TestService", method: "DeniedCallback" });
        });
    });

    describe("defaultPolicy allow", () => {
        it("should allow when no proto config, no rules, no callback and defaultPolicy is allow", async () => {
            const service = createFakeService();
            const plainMethod = createFakeMethod(service, "OpenMethod");

            const token = await createTestJwt({ sub: "user-1", roles: [] });
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "allow",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, plainMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("service-level defaults (reader.ts)", () => {
        it("should inherit service defaultRequires when method has no requires", () => {
            const svcOpts = createServiceOptions({
                defaultRequires: { roles: ["user"], scopes: ["read"] },
            });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "InheritedMethod");

            const resolved = resolveMethodAuth(method);
            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read"]);
        });

        it("should inherit service public=true", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "PublicByService");

            const resolved = resolveMethodAuth(method);
            assert.strictEqual(resolved.public, true);
        });

        it("should reject an unknown service default_policy string instead of deferring to the interceptor default", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "unknown-value" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "UnknownPolicy");

            assert.throws(() => resolveMethodAuth(method), /service_auth\.default_policy "unknown-value" on test\.v1\.TestService\/UnknownPolicy/);
        });

        it("should override service defaults with method-level settings", () => {
            const svcOpts = createServiceOptions({
                defaultRequires: { roles: ["user"] },
                defaultPolicy: "deny",
            });
            const service = createFakeService({ serviceOptions: svcOpts });
            const methodOpts = createMethodOptions({
                requires: { roles: ["admin"] },
                policy: "allow",
            });
            const method = createFakeMethod(service, "OverrideMethod", methodOpts);

            const resolved = resolveMethodAuth(method);
            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["admin"]);
            assert.strictEqual(resolved.policy, "allow");
        });

        // Guide: explicit method-level fields override their service-level counterparts, and an
        // omitted field inherits the service setting. `requires` and `policy` are separate fields.
        it("should replace the service requires as a whole when the method sets its own requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] } });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "ScopesOnly", createMethodOptions({ requires: { scopes: ["items:write"] } }));

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.scopes], ["items:write"]);
            assert.deepStrictEqual([...resolved.requires.roles], [], "the service's roles must not be merged into the method's own requires");
        });

        it("should inherit the service requires when the method sets only a policy", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"], scopes: ["read"] }, defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "PolicyOnly", createMethodOptions({ policy: "allow" }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "allow");
            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read"]);
        });

        it("should inherit the service policy when the method sets only requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] }, defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "RequiresOnly", createMethodOptions({ requires: { roles: ["admin"] } }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "deny");
            assert.deepStrictEqual([...(resolved.requires?.roles ?? [])], ["admin"]);
        });
    });

    describe("getPublicMethods", () => {
        it("should return public method patterns", () => {
            const svcOpts = createServiceOptions({});
            const service = createFakeService({ typeName: "svc.v1.Svc", serviceOptions: svcOpts });
            const publicMethod = createFakeMethod(service, "Health", createMethodOptions({ public: true }));
            const privateMethod = createFakeMethod(service, "Admin", createMethodOptions({ requires: { roles: ["admin"] } }));

            // Attach methods to service (needed by getPublicMethods iteration)
            (service as any).methods = [publicMethod, privateMethod];

            const patterns = getPublicMethods([service]);
            assert.deepStrictEqual(patterns, ["svc.v1.Svc/Health"]);
        });

        it("should return empty array when no methods are public", () => {
            const service = createFakeService({ typeName: "svc.v1.Private" });
            const method1 = createFakeMethod(service, "Secured", createMethodOptions({ requires: { roles: ["admin"] } }));
            const method2 = createFakeMethod(service, "AlsoSecured", createMethodOptions({ policy: "deny" }));

            (service as any).methods = [method1, method2];

            const patterns = getPublicMethods([service]);
            assert.deepStrictEqual(patterns, []);
        });

        it("should handle multiple services", () => {
            const svc1Opts = createServiceOptions({});
            const svc1 = createFakeService({ typeName: "a.v1.A", serviceOptions: svc1Opts });
            const svc1Public = createFakeMethod(svc1, "Ping", createMethodOptions({ public: true }));
            const svc1Private = createFakeMethod(svc1, "Secret", createMethodOptions({ requires: { roles: ["admin"] } }));
            (svc1 as any).methods = [svc1Public, svc1Private];

            // A public service makes every method of it public.
            const svc2Opts = createServiceOptions({ public: true });
            const svc2 = createFakeService({ typeName: "b.v1.B", serviceOptions: svc2Opts });
            const svc2Check = createFakeMethod(svc2, "Check");
            const svc2Other = createFakeMethod(svc2, "Other");
            (svc2 as any).methods = [svc2Check, svc2Other];

            // A service with no public marker at all contributes nothing.
            const svc3 = createFakeService({ typeName: "c.v1.C" });
            const svc3Method = createFakeMethod(svc3, "Closed");
            (svc3 as any).methods = [svc3Method];

            const patterns = getPublicMethods([svc1, svc2, svc3]);
            assert.deepStrictEqual([...patterns].sort(), ["a.v1.A/Ping", "b.v1.B/Check", "b.v1.B/Other"]);
        });
    });
});
