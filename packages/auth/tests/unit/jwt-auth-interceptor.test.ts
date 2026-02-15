/**
 * Unit tests for the JWT authentication interceptor
 *
 * Tests createJwtAuthInterceptor() for JWT verification,
 * claims mapping, and integration with the base auth interceptor.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

function createMockRequest(overrides: Record<string, unknown> = {}) {
    return {
        service: { typeName: "test.Service" },
        method: { name: "Method" },
        header: new Headers(),
        url: "http://localhost/test.Service/Method",
        stream: false,
        message: {},
        ...overrides,
    } as any;
}

describe("jwt-auth-interceptor", () => {
    describe("createJwtAuthInterceptor()", () => {
        it("should throw when no key option provided", () => {
            assert.throws(
                () => createJwtAuthInterceptor({}),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("jwksUri, secret, or publicKey"));
                    return true;
                },
            );
        });

        it("should verify JWT with HMAC secret successfully", async () => {
            const token = await createTestJwt({ sub: "user-1" });

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            const next = async (_req: any) => ({ message: {} });
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);
            // If no error is thrown, verification succeeded
        });

        it("should reject expired JWT", async () => {
            const token = await createTestJwt({ sub: "user-1" }, { expiresIn: "0s" });

            // Small delay to ensure expiration
            await new Promise((resolve) => setTimeout(resolve, 1100));

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            const next = async (_req: any) => ({ message: {} });
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should map standard claims (sub -> subject)", async () => {
            const token = await createTestJwt({ sub: "jwt-subject-42" });

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });

            let capturedContext: any;
            const next = async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "jwt-subject-42");
            assert.strictEqual(capturedContext.type, "jwt");
        });

        it("should map custom claims via claimsMapping (dot notation)", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                realm_access: { roles: ["admin", "editor"] },
                scope: "read write",
                preferred_username: "johndoe",
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "realm_access.roles",
                    scopes: "scope",
                    name: "preferred_username",
                },
            });

            let capturedContext: any;
            const next = async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);

            assert.ok(capturedContext);
            assert.deepStrictEqual(capturedContext.roles, ["admin", "editor"]);
            assert.deepStrictEqual(capturedContext.scopes, ["read", "write"]);
            assert.strictEqual(capturedContext.name, "johndoe");
        });

        it("should pass skipMethods to underlying auth interceptor", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.Service/Method"],
            });

            const next = async (_req: any) => ({ message: {} });
            const handler = interceptor(next as any);

            const req = createMockRequest();
            // No authorization header, but method is skipped

            await handler(req);
            // Should not throw — method is skipped
        });
    });
});
