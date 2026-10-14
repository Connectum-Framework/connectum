/**
 * Unit tests for the JWT authentication interceptor
 *
 * Tests createJwtAuthInterceptor() for JWT verification,
 * claims mapping, and integration with the base auth interceptor.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import * as jose from "jose";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

describe("jwt-auth-interceptor", () => {
    describe("createJwtAuthInterceptor()", () => {
        // The guide requires at least one key source (jwksUri, publicKey or secret); the
        // error must name all three so the operator knows what to configure, and an empty
        // string is not a key source.
        for (const [label, options] of [
            ["no options", {}],
            ["an empty secret", { secret: "" }],
            ["an empty jwksUri", { jwksUri: "" }],
        ] as const) {
            it(`should throw naming every key option when ${label} are given`, () => {
                assert.throws(
                    () => createJwtAuthInterceptor(options),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        for (const option of ["jwksUri", "publicKey", "secret"]) {
                            assert.ok(err.message.includes(option), `message "${err.message}" must name ${option}`);
                        }
                        return true;
                    },
                );
            });
        }

        it("should verify JWT with HMAC secret and expose the verified identity", async () => {
            const token = await createTestJwt({ sub: "user-1" });

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            let capturedContext: any;
            const next = async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);

            assert.ok(capturedContext, "handler must run inside an auth context");
            assert.strictEqual(capturedContext.subject, "user-1");
        });

        it("should reject a JWT signed with a different HMAC secret", async () => {
            // Same claims and algorithm, valid shape and expiry: only the signature key differs,
            // so the call fails exactly when the signature is actually verified.
            const otherKey = new TextEncoder().encode("another-secret-that-is-long-enough-for-hs256");
            const token = await new jose.SignJWT({ sub: "user-1" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(otherKey);

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            let nextCalls = 0;
            const next = async (_req: any) => {
                nextCalls++;
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(nextCalls, 0, "an unverified request must not reach the handler");
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await handler(req);

            assert.ok(capturedContext);
            assert.deepStrictEqual(capturedContext.roles, ["admin", "editor"]);
            assert.deepStrictEqual(capturedContext.scopes, ["read", "write"]);
            assert.strictEqual(capturedContext.name, "johndoe");
        });

        // Minimum HMAC key length per algorithm (RFC 7518 section 3.2, restated in the JWT guide):
        // HS256 32 bytes, HS384 48 bytes, HS512 64 bytes. Each row probes both sides of the
        // boundary so a shifted threshold (or the wrong threshold for an algorithm) is caught.
        const hmacBoundaries = [
            { algorithms: undefined, label: "default algorithms", minBytes: 32 },
            { algorithms: ["HS256"], label: "HS256", minBytes: 32 },
            { algorithms: ["HS384"], label: "HS384", minBytes: 48 },
            { algorithms: ["HS512"], label: "HS512", minBytes: 64 },
        ];
        for (const { algorithms, label, minBytes } of hmacBoundaries) {
            it(`should reject an HMAC secret one byte under the ${minBytes}-byte minimum for ${label}`, () => {
                assert.throws(
                    () => createJwtAuthInterceptor({ secret: "a".repeat(minBytes - 1), algorithms }),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.ok(err.message.includes(`at least ${minBytes} bytes`), err.message);
                        assert.ok(err.message.includes("RFC 7518"), err.message);
                        return true;
                    },
                );
            });

            it(`should accept an HMAC secret of exactly ${minBytes} bytes for ${label}`, () => {
                assert.doesNotThrow(() => createJwtAuthInterceptor({ secret: "a".repeat(minBytes), algorithms }));
            });
        }

        it("should measure the HMAC secret in UTF-8 bytes, not characters", () => {
            // The guide states the minimum in UTF-8 bytes. 16 two-byte characters are
            // 32 bytes (accepted); 15 of them plus one ASCII character are 31 bytes (rejected).
            assert.doesNotThrow(() => createJwtAuthInterceptor({ secret: "é".repeat(16) }));
            assert.throws(() => createJwtAuthInterceptor({ secret: `${"é".repeat(15)}a` }), /at least 32 bytes/);
        });

        it("should pass skipMethods to underlying auth interceptor", async () => {
            const interceptor = createJwtAuthInterceptor({
                secret: TEST_JWT_SECRET,
                skipMethods: ["test.Service/Method"],
            });

            const next = async (_req: any) => ({ message: {} });
            const handler = interceptor(next as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            // No authorization header, but method is skipped

            await handler(req);
            // Should not throw — method is skipped
        });
        it("should reject with Unauthenticated a validly signed JWT that has no subject claim", async () => {
            // A verified token without `sub` carries no identity: the call must fail closed
            // and the handler must never run with an anonymous or empty subject.
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const token = await new jose.SignJWT({ name: "No Subject User" })
                .setProtectedHeader({ alg: "HS256" })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(key);

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            let nextCalls = 0;
            const next = async (_req: any) => {
                nextCalls++;
                return { message: {} };
            };
            const handler = interceptor(next as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "missing subject");
                    return true;
                },
            );
            assert.strictEqual(nextCalls, 0, "a token without a subject must not reach the handler");
        });

        it("should accept a token younger than maxTokenAge and reject one older than it", async () => {
            // Two tokens on either side of the one-hour limit, same key and claims: the only
            // difference is `iat`, so the limit is what separates them.
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const sign = (ageSeconds: number) =>
                new jose.SignJWT({ sub: "user-1" })
                    .setProtectedHeader({ alg: "HS256" })
                    .setIssuedAt(Math.floor(Date.now() / 1000) - ageSeconds)
                    .setExpirationTime("24h")
                    .sign(key);

            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, maxTokenAge: "1h" });

            const call = async (token: string) => {
                let subject: string | undefined;
                const handler = interceptor((async () => {
                    subject = getAuthContext()?.subject;
                    return { message: {} };
                }) as any);
                const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
                req.header.set("authorization", `Bearer ${token}`);
                await handler(req);
                return subject;
            };

            assert.strictEqual(await call(await sign(3000)), "user-1");
            await assert.rejects(
                async () => call(await sign(3900)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });
    });
});
