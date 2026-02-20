/**
 * Integration tests for JWT AUTH -> PROTO AUTHZ interceptor chain.
 *
 * Tests the full chain: JWT authentication followed by proto-based
 * authorization using custom options defined in protobuf descriptors.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest, createServiceOptions } from "../helpers/proto-test-helpers.ts";

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
            const req = createProtoMockRequest(service, publicMethod);
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
            const req = createProtoMockRequest(service, adminMethod, headers);

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
            const req = createProtoMockRequest(service, scopedMethod, headers);

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
            const req = createProtoMockRequest(service, adminMethod, headers);

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
            const req = createProtoMockRequest(service, scopedMethod, headers);

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
            const req = createProtoMockRequest(service, noOptionsMethod, headers);

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
            const req = createProtoMockRequest(service, adminMethod);

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
