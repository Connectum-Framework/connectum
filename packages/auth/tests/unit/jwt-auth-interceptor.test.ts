/**
 * Unit tests for the JWT authentication interceptor
 *
 * Tests createJwtAuthInterceptor() for JWT verification,
 * claims mapping, and integration with the base auth interceptor.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import * as jose from "jose";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { createTestJwtRS256, generateRsaTestKeypair, type RsaTestKeypair, startTestJwksServer, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";

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
                    // The guide fixes the client text of a failed verification: the cause is not disclosed.
                    assert.strictEqual(err.rawMessage, "Authentication failed");
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

        // The guide ties the minimum to "those algorithms ... when configured": a list that names
        // several HMAC algorithms must satisfy the strongest of them, wherever it sits in the list.
        for (const [algorithms, minBytes] of [
            [["HS256", "HS512"], 64],
            [["HS512", "HS256"], 64],
            [["HS384", "HS512"], 64],
            [["HS256", "HS384"], 48],
            [["HS384", "HS256"], 48],
        ] as const) {
            it(`should require ${minBytes} bytes of secret when the algorithms are ${JSON.stringify(algorithms)}`, () => {
                assert.throws(() => createJwtAuthInterceptor({ secret: "a".repeat(minBytes - 1), algorithms: [...algorithms] }), new RegExp(`at least ${minBytes} bytes`));
                assert.doesNotThrow(() => createJwtAuthInterceptor({ secret: "a".repeat(minBytes), algorithms: [...algorithms] }));
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

            const next = createMockNext();
            const handler = interceptor(next);

            // No authorization header, but the method is listed
            await handler(createMockRequest(MOCK_REQUEST_DEFAULTS));
            assert.strictEqual(next.mock.calls.length, 1, "the listed method must reach the handler without a token");

            // A method outside the list still demands a token: the option must not switch authentication off wholesale.
            await assert.rejects(
                () => handler(createMockRequest({ service: "test.Service", method: "OtherMethod" })),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 1, "an unlisted method must not reach the handler");
        });        it("should reject with Unauthenticated a validly signed JWT that has no subject claim", async () => {
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
                    assertConnectError(err, Code.Unauthenticated);
                    // The guide names this text for a valid token that carries no subject.
                    assert.strictEqual(err.rawMessage, "JWT missing subject claim");
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

    describe("token validity rules", () => {
        const nowSeconds = () => Math.floor(Date.now() / 1000);

        /** Run one call; a refusal must be `Unauthenticated` and must not reach the handler. */
        async function admits(interceptor: Interceptor, token: string): Promise<boolean> {
            const next = createMockNext();
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);
            try {
                await interceptor(next)(req);
            } catch (err) {
                assertConnectError(err, Code.Unauthenticated);
                assert.strictEqual(next.mock.calls.length, 0, "a refused token must not reach the handler");
                return false;
            }
            return next.mock.calls.length === 1;
        }

        const hmacKey = new TextEncoder().encode(TEST_JWT_SECRET);

        it("should treat the exp second itself as expired and admit a token that expires later", async () => {
            // RFC 7519 section 4.1.4: the token must not be accepted on or after its exp time.
            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            const signWithExp = (exp: number) => new jose.SignJWT({ sub: "user-1" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(exp).sign(hmacKey);

            assert.strictEqual(await admits(interceptor, await signWithExp(nowSeconds() - 1)), false, "exp one second ago");
            assert.strictEqual(await admits(interceptor, await signWithExp(nowSeconds())), false, "exp equal to the current second");
            assert.strictEqual(await admits(interceptor, await signWithExp(nowSeconds() + 30)), true, "exp thirty seconds ahead");
        });

        it("should refuse a token before its nbf time and admit it from that second on", async () => {
            // RFC 7519 section 4.1.5: the token must not be accepted before its nbf time.
            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
            const signWithNbf = (nbf: number) => new jose.SignJWT({ sub: "user-1" }).setProtectedHeader({ alg: "HS256" }).setNotBefore(nbf).setExpirationTime("1h").sign(hmacKey);

            assert.strictEqual(await admits(interceptor, await signWithNbf(nowSeconds() + 10)), false, "nbf ten seconds ahead");
            assert.strictEqual(await admits(interceptor, await signWithNbf(nowSeconds())), true, "nbf equal to the current second");
            assert.strictEqual(await admits(interceptor, await signWithNbf(nowSeconds() - 600)), true, "nbf ten minutes ago");
        });

        it("should accept only the configured algorithms", async () => {
            // One 64-byte secret satisfies the minimum of every HMAC algorithm, so the algorithm
            // list is the only thing that separates the tokens below.
            const secret = "k".repeat(64);
            const key = new TextEncoder().encode(secret);
            const sign = (alg: string) => new jose.SignJWT({ sub: "user-1" }).setProtectedHeader({ alg }).setExpirationTime("1h").sign(key);
            const hs256 = await sign("HS256");
            const hs512 = await sign("HS512");

            const onlyHs256 = createJwtAuthInterceptor({ secret, algorithms: ["HS256"] });
            assert.strictEqual(await admits(onlyHs256, hs256), true);
            assert.strictEqual(await admits(onlyHs256, hs512), false, "an HS512 token must be refused when only HS256 is configured");

            const onlyHs512 = createJwtAuthInterceptor({ secret, algorithms: ["HS512"] });
            assert.strictEqual(await admits(onlyHs512, hs512), true);
            assert.strictEqual(await admits(onlyHs512, hs256), false, "an HS256 token must be refused when only HS512 is configured");

            // Without the option both are verified by the same key: the refusals above come from the option.
            const unrestricted = createJwtAuthInterceptor({ secret });
            assert.strictEqual(await admits(unrestricted, hs256), true);
            assert.strictEqual(await admits(unrestricted, hs512), true);
        });

        it("should refuse an unsecured token (alg none) for every key source", async () => {
            // RFC 7519 section 6 defines unsecured JWTs; a verifier that is configured with a key
            // must never accept a token that carries no signature.
            const unsecured = new jose.UnsecuredJWT({ sub: "user-1" }).setExpirationTime("1h").encode();
            const { publicKey } = await jose.generateKeyPair("ES256");

            assert.strictEqual(await admits(createJwtAuthInterceptor({ secret: TEST_JWT_SECRET }), unsecured), false, "secret");
            assert.strictEqual(await admits(createJwtAuthInterceptor({ publicKey }), unsecured), false, "publicKey");
        });
    });

    describe("key source priority", () => {
        let keypair: RsaTestKeypair;
        let jwks: TestJwksServer;

        before(async () => {
            keypair = await generateRsaTestKeypair();
            jwks = await startTestJwksServer(keypair.publicJwk);
        });

        after(async () => {
            await jwks.close();
        });

        async function admits(interceptor: Interceptor, token: string): Promise<boolean> {
            const next = createMockNext();
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", `Bearer ${token}`);
            try {
                await interceptor(next)(req);
            } catch (err) {
                assertConnectError(err, Code.Unauthenticated);
                return false;
            }
            return next.mock.calls.length === 1;
        }

        it("should verify against jwksUri and ignore publicKey and secret when all three are set", async () => {
            // The guide: if jwksUri is set, publicKey and secret are ignored.
            const { publicKey: unrelatedKey } = await jose.generateKeyPair("ES256");
            const interceptor = createJwtAuthInterceptor({ jwksUri: jwks.url, publicKey: unrelatedKey, secret: TEST_JWT_SECRET });

            const publishedKeyToken = await createTestJwtRS256(keypair.privateKey, { sub: "user-1" }, { kid: keypair.kid });
            assert.strictEqual(await admits(interceptor, publishedKeyToken), true, "a token signed by the published key");

            // The secret would verify this token if it were not ignored.
            assert.strictEqual(await admits(interceptor, await createTestJwt({ sub: "user-1" })), false, "a token signed with the ignored secret");
        });
    });
});
