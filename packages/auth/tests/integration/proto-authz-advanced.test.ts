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
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema, ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthRequirementsSchema, MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { getPublicMethods, resolveMethodAuth } from "../../src/proto/reader.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

function createFakeService(options?: { typeName?: string; serviceOptions?: unknown }): DescService {
    return {
        kind: "service",
        typeName: options?.typeName ?? "test.v1.TestService",
        name: "TestService",
        methods: [],
        method: {},
        deprecated: false,
        proto: { options: options?.serviceOptions },
    } as unknown as DescService;
}

function createFakeMethod(service: DescService, name: string, methodOptions?: unknown): DescMethod {
    return {
        kind: "rpc",
        name,
        localName: name.charAt(0).toLowerCase() + name.slice(1),
        parent: service,
        methodKind: "unary",
        deprecated: false,
        proto: { options: methodOptions },
    } as unknown as DescMethod;
}

function createMethodOptions(authConfig: { public?: boolean; policy?: string; requires?: { roles?: string[]; scopes?: string[] } }) {
    const opts = create(MethodOptionsSchema);
    const init: Record<string, unknown> = {
        public: authConfig.public ?? false,
        policy: authConfig.policy ?? "",
    };
    if (authConfig.requires) {
        init.requires = create(AuthRequirementsSchema, {
            roles: authConfig.requires.roles ?? [],
            scopes: authConfig.requires.scopes ?? [],
        });
    }
    const authMsg = create(MethodAuthSchema, init as any);
    setExtension(opts, method_auth, authMsg);
    return opts;
}

function createServiceOptions(authConfig: {
    defaultPolicy?: string;
    public?: boolean;
    defaultRequires?: { roles?: string[]; scopes?: string[] };
}) {
    const opts = create(ServiceOptionsSchema);
    const init: Record<string, unknown> = {
        defaultPolicy: authConfig.defaultPolicy ?? "",
    };
    if (authConfig.public !== undefined) {
        init.public = authConfig.public;
    }
    if (authConfig.defaultRequires) {
        init.defaultRequires = create(AuthRequirementsSchema, {
            roles: authConfig.defaultRequires.roles ?? [],
            scopes: authConfig.defaultRequires.scopes ?? [],
        });
    }
    const authMsg = create(ServiceAuthSchema, init as any);
    setExtension(opts, service_auth, authMsg);
    return opts;
}

function createMockRequest(service: DescService, method: DescMethod, headers?: Headers) {
    return {
        service,
        method,
        header: headers ?? new Headers(),
        url: `http://localhost/${service.typeName}/${method.name}`,
        stream: false,
        message: {},
    } as any;
}

function buildChainedHandler(
    authInterceptor: ReturnType<typeof createJwtAuthInterceptor>,
    authzInterceptor: ReturnType<typeof createProtoAuthzInterceptor>,
    next: any,
) {
    return authInterceptor(authzInterceptor(next as any) as any);
}

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
            const req = createMockRequest(service, allowMethod, headers);

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
            const req = createMockRequest(service, denyMethod, headers);

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
            const req = createMockRequest(service, plainMethod, headers);

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
            const req = createMockRequest(service, plainMethod, headers);

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
            const req = createMockRequest(service, plainMethod, headers);

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
            const req = createMockRequest(service, plainMethod, headers);

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
            const authzInterceptor = createProtoAuthzInterceptor({
                defaultPolicy: "allow",
                authorize: () => false,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, plainMethod, headers);

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
            const req = createMockRequest(service, plainMethod, headers);

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

        it("should return undefined policy for unknown policy string", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "unknown-value" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "UnknownPolicy");

            const resolved = resolveMethodAuth(method);
            assert.strictEqual(resolved.policy, undefined);
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
            (svc1 as any).methods = [svc1Public];

            const svc2Opts = createServiceOptions({ public: true });
            const svc2 = createFakeService({ typeName: "b.v1.B", serviceOptions: svc2Opts });
            const svc2Method = createFakeMethod(svc2, "Check");
            (svc2 as any).methods = [svc2Method];

            const patterns = getPublicMethods([svc1, svc2]);
            assert.ok(patterns.includes("a.v1.A/Ping"));
            assert.ok(patterns.includes("b.v1.B/Check"));
        });
    });
});
