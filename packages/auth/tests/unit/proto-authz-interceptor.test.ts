/**
 * Unit tests for the proto-based authorization interceptor.
 *
 * Tests createProtoAuthzInterceptor() for proto option reading,
 * public method bypass, role/scope checking, policy enforcement,
 * fallback to programmatic rules, and default policy behavior.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthRequirementsSchema, MethodAuthSchema, method_auth } from "#gen/connectum/auth/v1/options_pb.js";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext, AuthzRule } from "../../src/types.ts";

/**
 * Create a fake DescService.
 */
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

/**
 * Create a fake DescMethod.
 */
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

function createMockRequest(service: DescService, method: DescMethod) {
    return {
        service,
        method,
        header: new Headers(),
        url: `http://localhost/${service.typeName}/${method.name}`,
        stream: false,
        message: {},
    } as any;
}

function createMockNext() {
    return mock.fn(async (_req: any) => ({ message: {} })) as any;
}

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
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when user lacks required role", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AdminOnly", createMethodOptions({ requires: { roles: ["superadmin"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when user is missing a required scope", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ScopedMethod", createMethodOptions({ requires: { scopes: ["read", "delete"] } }));

            const interceptor = createProtoAuthzInterceptor();
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny when proto policy is 'deny'", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "DeniedMethod", createMethodOptions({ policy: "deny" }));

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow" });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

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
            const req = createMockRequest(service, method);

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    assert.ok((err as ConnectError).message.includes("default policy"));
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
            const req = createMockRequest(service, method);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
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
            const req = createMockRequest(service, method);

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny via fallback rule effect: deny", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "BlockedMethod");

            const rules: AuthzRule[] = [{ name: "block-all", methods: ["*"], effect: "deny" }];

            const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", rules });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest(service, method);

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
});
