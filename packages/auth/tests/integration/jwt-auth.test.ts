/**
 * Integration tests for JWT authentication interceptor
 *
 * Tests the full JWT flow: token creation, verification,
 * context propagation, and error handling.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

/**
 * Create a mock ConnectRPC unary request.
 */
function createMockRequest(headers?: Headers) {
    return {
        service: { typeName: "test.v1.TestService" },
        method: { name: "TestMethod" },
        header: headers ?? new Headers(),
        url: "http://localhost/test.v1.TestService/TestMethod",
        stream: false,
        message: {},
    } as any;
}

describe("JWT Auth Interceptor — Integration", () => {
    describe("valid JWT verification", () => {
        it("should verify a valid JWT and set AuthContext", async () => {
            const token = await createTestJwt({
                sub: "user-123",
                name: "John Doe",
                roles: ["admin", "user"],
                scope: "read write",
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "roles",
                    scopes: "scope",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext!);
            assert.strictEqual(capturedContext!.subject, "user-123");
            assert.strictEqual(capturedContext!.name, "John Doe");
            assert.deepStrictEqual([...capturedContext!.roles], ["admin", "user"]);
            assert.deepStrictEqual([...capturedContext!.scopes], ["read", "write"]);
            assert.strictEqual(capturedContext!.type, "jwt");
            assert.ok(capturedContext!.expiresAt instanceof Date);
        });

        it("should use sub claim as subject by default", async () => {
            const token = await createTestJwt({ sub: "default-sub-user" });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(capturedContext!.subject, "default-sub-user");
        });

        it("should default roles and scopes to empty arrays when not present", async () => {
            const token = await createTestJwt({ sub: "minimal-user" });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.deepStrictEqual([...capturedContext!.roles], []);
            assert.deepStrictEqual([...capturedContext!.scopes], []);
        });
    });

    describe("invalid JWT rejection", () => {
        it("should reject an invalid token string", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
            });

            const headers = new Headers();
            headers.set("authorization", "Bearer invalid-token");
            const req = createMockRequest(headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

        it("should reject a request without Authorization header", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
            });

            const req = createMockRequest();

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

        it("should reject a token signed with wrong secret", async () => {
            // Create token with a different secret by using jose directly
            const { SignJWT } = await import("jose");
            const wrongSecret = new TextEncoder().encode("wrong-secret-value");
            const token = await new SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(wrongSecret);

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

    describe("issuer validation", () => {
        it("should reject JWT with wrong issuer when issuer is specified", async () => {
            const token = await createTestJwt(
                { sub: "user-1" },
                { issuer: "wrong-issuer" },
            );

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                issuer: "expected-issuer",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

        it("should accept JWT with correct issuer", async () => {
            const token = await createTestJwt(
                { sub: "user-1" },
                { issuer: "my-service" },
            );

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                issuer: "my-service",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(capturedContext!.subject, "user-1");
        });

        it("should reject JWT without issuer when issuer is required", async () => {
            const token = await createTestJwt({ sub: "user-1" });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                issuer: "required-issuer",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

    describe("custom claimsMapping", () => {
        it("should map roles from a custom nested claim path", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                realm_access: {
                    roles: ["realm-admin", "realm-user"],
                },
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "realm_access.roles",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.deepStrictEqual([...capturedContext!.roles], ["realm-admin", "realm-user"]);
        });

        it("should map scopes from a custom claim path (space-separated string)", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                permissions: "admin:read admin:write users:read",
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    scopes: "permissions",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.deepStrictEqual([...capturedContext!.scopes], ["admin:read", "admin:write", "users:read"]);
        });

        it("should map scopes from a custom claim path (array)", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                scope_list: ["scope-a", "scope-b"],
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    scopes: "scope_list",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.deepStrictEqual([...capturedContext!.scopes], ["scope-a", "scope-b"]);
        });

        it("should map subject from a custom claim path", async () => {
            const token = await createTestJwt({
                sub: "original-sub",
                user_info: { id: "custom-id-42" },
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    subject: "user_info.id",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(capturedContext!.subject, "custom-id-42");
        });

        it("should map name from a custom claim path", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                profile: { display_name: "Custom Name" },
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    name: "profile.display_name",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(capturedContext!.name, "Custom Name");
        });

        it("should map all custom claims simultaneously", async () => {
            const token = await createTestJwt({
                user_id: "mapped-user",
                display: "Mapped User",
                access: { roles: ["editor"] },
                granted_scopes: "files:read files:write",
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    subject: "user_id",
                    name: "display",
                    roles: "access.roles",
                    scopes: "granted_scopes",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(capturedContext!.subject, "mapped-user");
            assert.strictEqual(capturedContext!.name, "Mapped User");
            assert.deepStrictEqual([...capturedContext!.roles], ["editor"]);
            assert.deepStrictEqual([...capturedContext!.scopes], ["files:read", "files:write"]);
        });
    });

    describe("skipMethods", () => {
        it("should skip authentication for listed methods", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.v1.TestService/TestMethod"],
            });

            // Request without any Authorization header
            const req = createMockRequest();

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            // Should NOT throw despite missing credentials
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should skip authentication for wildcard service patterns", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.v1.TestService/*"],
            });

            const req = createMockRequest();

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should still require auth for non-skipped methods", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["other.v1.OtherService/*"],
            });

            const req = createMockRequest();

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

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

    describe("header propagation", () => {
        it("should set auth headers when propagateHeaders is enabled", async () => {
            const token = await createTestJwt({
                sub: "prop-user",
                roles: ["admin"],
                scope: "read write",
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                propagateHeaders: true,
                claimsMapping: {
                    roles: "roles",
                    scopes: "scope",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest(headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await handler(req);

            assert.strictEqual(req.header.get("x-auth-subject"), "prop-user");
            assert.strictEqual(req.header.get("x-auth-type"), "jwt");
            assert.strictEqual(req.header.get("x-auth-roles"), JSON.stringify(["admin"]));
            assert.strictEqual(req.header.get("x-auth-scopes"), "read write");
        });
    });
});
