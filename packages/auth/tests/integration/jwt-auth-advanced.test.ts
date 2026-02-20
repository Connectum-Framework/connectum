/**
 * Integration tests for JWT auth interceptor advanced paths.
 *
 * Covers: audience validation, HMAC key sizes (HS384/HS512),
 * RSA public key verification, nested claims edge cases,
 * missing subject, maxTokenAge, constructor errors, JWKS.
 */

import assert from "node:assert";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { after, before, describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import * as jose from "jose";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { createMockRequest } from "../helpers/mock-request.ts";

describe("JWT Auth Advanced — Integration", () => {
    describe("audience validation", () => {
        it("should reject JWT without matching audience", async () => {
            const token = await createTestJwt(
                { sub: "user-1" },
                { audience: "wrong-audience" },
            );

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                audience: "my-api",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

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

        it("should accept JWT with correct audience", async () => {
            const token = await createTestJwt(
                { sub: "user-1" },
                { audience: "my-api" },
            );

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                audience: "my-api",
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("HMAC key size validation", () => {
        it("should throw for HS384 with undersized secret", () => {
            assert.throws(
                () =>
                    createJwtAuthInterceptor({
                        secret: "short-secret", // <48 bytes
                        algorithms: ["HS384"],
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /at least 48 bytes/);
                    return true;
                },
            );
        });

        it("should throw for HS512 with undersized secret", () => {
            assert.throws(
                () =>
                    createJwtAuthInterceptor({
                        secret: "short-secret", // <64 bytes
                        algorithms: ["HS512"],
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /at least 64 bytes/);
                    return true;
                },
            );
        });

        it("should accept HS384 with properly sized secret", async () => {
            // 48 bytes minimum for HS384
            const secret384 = "a".repeat(48);
            const key = new TextEncoder().encode(secret384);
            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS384" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(key);

            const interceptor = createJwtAuthInterceptor({
                secret: secret384,
                algorithms: ["HS384"],
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await handler(req);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("asymmetric key (RSA)", () => {
        it("should verify JWT signed with RSA private key using public key", async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("RS256");

            const token = await new jose.SignJWT({ sub: "rsa-user", roles: ["admin"] })
                .setProtectedHeader({ alg: "RS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(privateKey);

            const interceptor = createJwtAuthInterceptor({
                publicKey: publicKey as CryptoKey,
                algorithms: ["RS256"],
                claimsMapping: { roles: "roles" },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            let captured: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(captured!);
            assert.strictEqual(captured!.subject, "rsa-user");
            assert.deepStrictEqual([...captured!.roles], ["admin"]);
        });
    });

    describe("nested claims edge cases", () => {
        it("should return undefined for null intermediate in nested path", async () => {
            const token = await createTestJwt({
                sub: "user-1",
                parent: null,
            });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    roles: "parent.child.roles",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            let captured: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            // roles mapping returns undefined → defaults to []
            assert.deepStrictEqual([...captured!.roles], []);
        });

        it("should return undefined for missing intermediate in nested path", async () => {
            const token = await createTestJwt({ sub: "user-1" });

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                claimsMapping: {
                    name: "missing.nested.name",
                },
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            let captured: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(captured!.name, undefined);
        });
    });

    describe("missing subject", () => {
        it("should throw Unauthenticated when JWT has no sub and no subject mapping", async () => {
            // JWT without "sub" claim
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const token = await new jose.SignJWT({ roles: ["admin"] })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(key);

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                // no claimsMapping.subject, and JWT has no "sub"
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /missing subject/i);
                    return true;
                },
            );
        });
    });

    describe("maxTokenAge", () => {
        it("should reject token older than maxTokenAge", async () => {
            // Create a token with iat in the past
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const pastIat = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt(pastIat)
                .setExpirationTime("2h") // still valid by exp, but iat is too old
                .sign(key);

            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                maxTokenAge: "30m", // max 30 minutes
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

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

    describe("constructor errors", () => {
        it("should throw when no key is provided", () => {
            assert.throws(
                () => createJwtAuthInterceptor({}),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /requires one of/);
                    return true;
                },
            );
        });
    });

    describe("JWKS remote key set", () => {
        let jwksServer: Server;
        let jwksPort: number;
        let rsaPrivateKey: CryptoKey;
        let jwksData: jose.JSONWebKeySet;

        before(async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
            rsaPrivateKey = privateKey as CryptoKey;
            const publicJwk = await jose.exportJWK(publicKey);
            publicJwk.kid = "test-kid";
            publicJwk.alg = "RS256";
            jwksData = { keys: [publicJwk] };

            await new Promise<void>((resolve) => {
                jwksServer = createServer((_req, res) => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(jwksData));
                });
                jwksServer.listen(0, () => {
                    const addr = jwksServer.address();
                    jwksPort = typeof addr === "object" && addr ? addr.port : 0;
                    resolve();
                });
            });
        });

        after(() => {
            jwksServer?.close();
        });

        it("should verify JWT via remote JWKS endpoint", async () => {
            const token = await new jose.SignJWT({ sub: "jwks-user" })
                .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(rsaPrivateKey);

            const interceptor = createJwtAuthInterceptor({
                jwksUri: `http://localhost:${jwksPort}/.well-known/jwks.json`,
            });

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createMockRequest({ headers });

            let captured: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(captured!);
            assert.strictEqual(captured!.subject, "jwks-user");
        });
    });
});
