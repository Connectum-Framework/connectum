/**
 * Integration tests for JWT AUTH -> PROTO AUTHZ interceptor chain.
 *
 * Tests the full chain: JWT authentication followed by proto-based
 * authorization using custom options defined in protobuf descriptors.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema, ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthRequirementsSchema, MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

/** Create a fake DescService with optional proto service options. */
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

/** Create a fake DescMethod attached to a service. */
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

/** Create MethodOptions with method_auth extension set. */
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

/** Create ServiceOptions with service_auth extension set. */
function createServiceOptions(authConfig: { defaultPolicy?: string }) {
    const opts = create(ServiceOptionsSchema);
    const authMsg = create(ServiceAuthSchema, {
        defaultPolicy: authConfig.defaultPolicy ?? "",
    });
    setExtension(opts, service_auth, authMsg);
    return opts;
}

/** Create a mock ConnectRPC request with proto service/method descriptors. */
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

/** Build a chained JWT auth → proto authz interceptor handler. */
function buildChainedHandler(
    authInterceptor: ReturnType<typeof createJwtAuthInterceptor>,
    authzInterceptor: ReturnType<typeof createProtoAuthzInterceptor>,
    next: any,
) {
    return authInterceptor(authzInterceptor(next as any) as any);
}

describe("Proto Auth Chain (JWT AUTH -> PROTO AUTHZ) — Integration", () => {
    const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
    const service = createFakeService({ serviceOptions: svcOpts });

    const publicMethod = createFakeMethod(service, "Health", createMethodOptions({ public: true }));
    const adminMethod = createFakeMethod(service, "AdminAction", createMethodOptions({ requires: { roles: ["admin"] } }));
    const scopedMethod = createFakeMethod(service, "ScopedAction", createMethodOptions({ requires: { roles: ["user"], scopes: ["items:write"] } }));
    const noOptionsMethod = createFakeMethod(service, "PlainMethod");

    function createChain() {
        const authInterceptor = createJwtAuthInterceptor({
            secret: TEST_JWT_SECRET,
            claimsMapping: { roles: "roles", scopes: "scope" },
            skipMethods: ["test.v1.TestService/Health"],
        });
        const authzInterceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
        return { authInterceptor, authzInterceptor };
    }

    describe("public methods", () => {
        it("should skip both authn and authz for public proto methods", async () => {
            const { authInterceptor, authzInterceptor } = createChain();
            const req = createMockRequest(service, publicMethod);
            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            // No auth header, should pass because method is public
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("authorized access", () => {
        it("should allow admin user to access admin-protected method", async () => {
            const token = await createTestJwt({ sub: "admin-1", roles: ["admin"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, adminMethod, headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext!);
            assert.strictEqual(capturedContext!.subject, "admin-1");
            assert.deepStrictEqual([...capturedContext!.roles], ["admin"]);
        });

        it("should allow user with correct role and scopes", async () => {
            const token = await createTestJwt({ sub: "user-1", roles: ["user"], scope: "items:read items:write" });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, scopedMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("permission denied", () => {
        it("should deny user without required role on admin method", async () => {
            const token = await createTestJwt({ sub: "viewer-1", roles: ["viewer"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, adminMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should deny user with role but missing required scope", async () => {
            const token = await createTestJwt({ sub: "user-2", roles: ["user"], scope: "items:read" });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, scopedMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });
    });

    describe("default policy fallback", () => {
        it("should deny method without proto options when defaultPolicy is deny", async () => {
            const token = await createTestJwt({ sub: "admin-2", roles: ["admin"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(service, noOptionsMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });
    });

    describe("unauthenticated access", () => {
        it("should reject non-public method without auth token", async () => {
            const { authInterceptor, authzInterceptor } = createChain();
            const req = createMockRequest(service, adminMethod);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });
    });
});
