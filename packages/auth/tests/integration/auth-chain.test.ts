/**
 * Integration tests for AUTH -> AUTHZ interceptor chain
 *
 * Tests the full chain: JWT authentication followed by
 * role-based authorization using declarative rules.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

/**
 * Create a mock ConnectRPC unary request.
 */
function createMockRequest(options?: {
    serviceName?: string;
    methodName?: string;
    headers?: Headers;
}) {
    const serviceName = options?.serviceName ?? "test.v1.TestService";
    const methodName = options?.methodName ?? "TestMethod";
    const headers = options?.headers ?? new Headers();

    return {
        service: { typeName: serviceName },
        method: { name: methodName },
        header: headers,
        url: `http://localhost/${serviceName}/${methodName}`,
        stream: false,
        message: {},
    } as any;
}

/**
 * Create the standard auth + authz interceptor chain.
 */
function createAuthChain(authzOptions?: Parameters<typeof createAuthzInterceptor>[0]) {
    const authInterceptor = createJwtAuthInterceptor({
        secret: TEST_JWT_SECRET,
        claimsMapping: {
            roles: "roles",
            scopes: "scope",
        },
    });

    const authzInterceptor = createAuthzInterceptor(
        authzOptions ?? {
            defaultPolicy: "deny",
            rules: [
                {
                    name: "admin",
                    methods: ["test.v1.TestService/*"],
                    requires: { roles: ["admin"] },
                    effect: "allow",
                },
                {
                    name: "user-read",
                    methods: ["test.v1.TestService/GetItem"],
                    requires: { roles: ["user"] },
                    effect: "allow",
                },
            ],
        },
    );

    return { authInterceptor, authzInterceptor };
}

/**
 * Build the chained handler: auth wraps authz wraps next.
 */
function buildChainedHandler(
    authInterceptor: ReturnType<typeof createJwtAuthInterceptor>,
    authzInterceptor: ReturnType<typeof createAuthzInterceptor>,
    next: any,
) {
    return authInterceptor(authzInterceptor(next as any) as any);
}

describe("Auth Chain (AUTH -> AUTHZ) — Integration", () => {
    describe("authorized access", () => {
        it("should allow admin user to access admin-protected method", async () => {
            const token = await createTestJwt({
                sub: "admin-user-1",
                roles: ["admin"],
                scope: "full",
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext!);
            assert.strictEqual(capturedContext!.subject, "admin-user-1");
            assert.deepStrictEqual([...capturedContext!.roles], ["admin"]);
        });

        it("should allow user with 'user' role to access GetItem", async () => {
            const token = await createTestJwt({
                sub: "regular-user-1",
                roles: ["user"],
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({
                methodName: "GetItem",
                headers,
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should allow user with both admin and user roles", async () => {
            const token = await createTestJwt({
                sub: "superuser",
                roles: ["admin", "user"],
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("permission denied", () => {
        it("should deny authenticated user without required role", async () => {
            const token = await createTestJwt({
                sub: "user-no-role",
                roles: ["viewer"],
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

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

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should deny user with 'user' role on non-GetItem method", async () => {
            const token = await createTestJwt({
                sub: "regular-user",
                roles: ["user"],
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            // DeleteItem is not in any "allow" rule for "user" role
            const req = createMockRequest({
                methodName: "DeleteItem",
                headers,
            });

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

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should deny user with empty roles", async () => {
            const token = await createTestJwt({
                sub: "no-roles-user",
                roles: [],
            });

            const { authInterceptor, authzInterceptor } = createAuthChain();

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

    describe("unauthenticated access", () => {
        it("should reject request without Authorization header", async () => {
            const { authInterceptor, authzInterceptor } = createAuthChain();

            const req = createMockRequest();

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

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should reject request with invalid token", async () => {
            const { authInterceptor, authzInterceptor } = createAuthChain();

            const headers = new Headers();
            headers.set("authorization", "Bearer invalid-garbage-token");
            const req = createMockRequest({ headers });

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

            assert.strictEqual(next.mock.calls.length, 0);
        });
    });

    describe("skipMethods in chain", () => {
        it("should skip both auth and authz for methods skipped in auth interceptor", async () => {
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.v1.TestService/HealthCheck"],
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                skipMethods: ["test.v1.TestService/HealthCheck"],
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                ],
            });

            const req = createMockRequest({
                methodName: "HealthCheck",
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            // No auth header, should still pass because method is skipped
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should still enforce auth on non-skipped methods", async () => {
            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.v1.TestService/HealthCheck"],
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                skipMethods: ["test.v1.TestService/HealthCheck"],
                rules: [
                    {
                        name: "admin-only",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
                        effect: "allow",
                    },
                ],
            });

            // Non-skipped method without auth
            const req = createMockRequest({
                methodName: "SecureMethod",
            });

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

        it("should skip authz only for authz-skipped methods while still requiring auth", async () => {
            const token = await createTestJwt({
                sub: "basic-user",
                roles: ["viewer"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            // Only authz skips this method, auth still runs
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                skipMethods: ["test.v1.TestService/PublicInfo"],
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
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({
                methodName: "PublicInfo",
                headers,
            });

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            await handler(req);

            // Auth context is set (auth ran) but authz was skipped (viewer has no admin role)
            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext!);
            assert.strictEqual(capturedContext!.subject, "basic-user");
        });
    });

    describe("header propagation in chain", () => {
        it("should propagate auth headers through the entire chain", async () => {
            const token = await createTestJwt({
                sub: "propagated-user",
                roles: ["admin"],
                scope: "read write",
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                propagateHeaders: true,
                claimsMapping: {
                    roles: "roles",
                    scopes: "scope",
                },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "admin",
                        methods: ["test.v1.TestService/*"],
                        requires: { roles: ["admin"] },
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

            // Verify auth headers were propagated
            assert.strictEqual(req.header.get("x-auth-subject"), "propagated-user");
            assert.strictEqual(req.header.get("x-auth-type"), "jwt");
            assert.strictEqual(req.header.get("x-auth-roles"), JSON.stringify(["admin"]));
            assert.strictEqual(req.header.get("x-auth-scopes"), "read write");
        });

        it("should have auth headers available even after authz denied", async () => {
            const token = await createTestJwt({
                sub: "denied-user",
                roles: ["viewer"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                propagateHeaders: true,
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

            // Auth headers were set before authz denied
            assert.strictEqual(req.header.get("x-auth-subject"), "denied-user");
            assert.strictEqual(req.header.get("x-auth-type"), "jwt");
        });
    });

    describe("scope-based authorization in chain", () => {
        it("should allow access when required scopes are present", async () => {
            const token = await createTestJwt({
                sub: "scoped-user",
                roles: [],
                scope: "items:read items:write",
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "roles",
                    scopes: "scope",
                },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "items-reader",
                        methods: ["test.v1.TestService/GetItem"],
                        requires: { scopes: ["items:read"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({
                methodName: "GetItem",
                headers,
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should deny access when required scopes are missing", async () => {
            const token = await createTestJwt({
                sub: "limited-user",
                roles: [],
                scope: "items:read",
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "roles",
                    scopes: "scope",
                },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "items-writer",
                        methods: ["test.v1.TestService/UpdateItem"],
                        requires: { scopes: ["items:read", "items:write"] },
                        effect: "allow",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({
                methodName: "UpdateItem",
                headers,
            });

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

    describe("default policy", () => {
        it("should deny by default when no rules match", async () => {
            const token = await createTestJwt({
                sub: "some-user",
                roles: ["admin"],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            // Rules for a different service entirely
            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "deny",
                rules: [
                    {
                        name: "other-service",
                        methods: ["other.v1.OtherService/*"],
                        requires: { roles: ["admin"] },
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

        it("should allow by default when defaultPolicy is 'allow' and no rules match", async () => {
            const token = await createTestJwt({
                sub: "any-user",
                roles: [],
            });

            const authInterceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: { roles: "roles" },
            });

            const authzInterceptor = createAuthzInterceptor({
                defaultPolicy: "allow",
                rules: [
                    {
                        name: "block-delete",
                        methods: ["test.v1.TestService/DeleteItem"],
                        effect: "deny",
                    },
                ],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({
                methodName: "GetItem",
                headers,
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });
});
