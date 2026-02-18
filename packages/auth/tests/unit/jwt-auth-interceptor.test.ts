/**
 * Unit tests for the JWT authentication interceptor
 *
 * Tests createJwtAuthInterceptor() for JWT verification,
 * claims mapping, and integration with the base auth interceptor.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import * as jose from "jose";
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
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
                .sign(key);

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

        it("should throw when HMAC secret is too short for HS256", () => {
            assert.throws(
                () => createJwtAuthInterceptor({ secret: "short" }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("at least 32 bytes"));
                    assert.ok(err.message.includes("RFC 7518"));
                    return true;
                },
            );
        });

        it("should accept HMAC secret of exactly 32 bytes", () => {
            const secret32 = "a".repeat(32);
            // Should not throw
            createJwtAuthInterceptor({ secret: secret32 });
        });

        it("should throw when HMAC secret is too short for HS512", () => {
            const secret32 = "a".repeat(32);
            assert.throws(
                () => createJwtAuthInterceptor({ secret: secret32, algorithms: ["HS512"] }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("at least 64 bytes"));
                    return true;
                },
            );
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
        it("should throw Unauthenticated when JWT has no subject claim (SEC-002)", async () => {
            // Create a JWT without 'sub' claim
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const token = await new jose.SignJWT({ name: "No Subject User" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(key);

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
                    assert.ok(err.message.includes("missing subject"));
                    return true;
                },
            );
        });

        it("should support maxTokenAge option", async () => {
            const token = await createTestJwt({ sub: "user-1" });

            // maxTokenAge of "1h" — token was just created, should be valid
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                maxTokenAge: "1h",
            });
            const next = async (_req: any) => ({ message: {} });
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);
            // No error = maxTokenAge accepted the token
        });

        it("should reject token exceeding maxTokenAge", async () => {
            // Create a token with iat in the past
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const pastIat = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt(pastIat)
                .setExpirationTime("24h")
                .sign(key);

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                maxTokenAge: "1h", // 1 hour max age, but token is 2 hours old
            });
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

        it("should verify JWT with EC publicKey (ES256)", async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("ES256");

            const token = await new jose.SignJWT({ sub: "ec-user" })
                .setProtectedHeader({ alg: "ES256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(privateKey);

            const interceptor = createJwtAuthInterceptor({ publicKey });

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
            assert.strictEqual(capturedContext.subject, "ec-user");
            assert.strictEqual(capturedContext.type, "jwt");
        });

        it("should verify JWT with RSA publicKey (RS256)", async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("RS256");

            const token = await new jose.SignJWT({ sub: "rsa-user" })
                .setProtectedHeader({ alg: "RS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(privateKey);

            const interceptor = createJwtAuthInterceptor({ publicKey });

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
            assert.strictEqual(capturedContext.subject, "rsa-user");
        });

        it("should use publicKey over secret when both provided (priority check)", async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("ES256");

            // Sign with the EC private key
            const token = await new jose.SignJWT({ sub: "priority-user" })
                .setProtectedHeader({ alg: "ES256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(privateKey);

            // Provide both publicKey and secret — publicKey should win
            const interceptor = createJwtAuthInterceptor({
                publicKey,
                secret: TEST_JWT_SECRET,
            });

            let capturedContext: any;
            const next = async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest();
            req.header.set("authorization", `Bearer ${token}`);

            // If secret were used instead of publicKey, this would throw
            // because the token is signed with EC, not HMAC
            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "priority-user");
        });

        it("should reject JWT signed with wrong asymmetric key", async () => {
            const { publicKey } = await jose.generateKeyPair("ES256");
            const { privateKey: wrongPrivateKey } = await jose.generateKeyPair("ES256");

            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "ES256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(wrongPrivateKey);

            const interceptor = createJwtAuthInterceptor({ publicKey });
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
    });
});
