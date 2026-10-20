/**
 * Unit tests for the internal (service-to-service) auth interceptor (ADR-029).
 *
 * Covers:
 * - per-service containment: an A-signed token claiming `iss: B` is REJECTED
 *   (the empirical issuer-bound JWKS finding from ADR-029 §2);
 * - meshIdentityTrust allow-list (allow / deny + header stripping);
 * - signedTokenTrust happy path and identity binding;
 * - sharedSecretTrust constant-time compare;
 * - no-marker -> Unauthenticated; non-internal method -> no-op pass-through.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import * as jose from "jose";
import { getAuthContext } from "../../src/context.ts";
import { createInternalAuthInterceptor, meshIdentityTrust, sharedSecretTrust, signedTokenTrust } from "../../src/internal-auth-interceptor.ts";
import { createTestJwtRS256, generateRsaTestKeypair, type RsaTestKeypair, startTestJwksServer, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";
import type { AuthContext } from "../../src/types.ts";

const SERVICE = "trips.v1.TripService";
const INTERNAL_METHOD = "RecordTrip";
const INTERNAL_PATTERN = `${SERVICE}/${INTERNAL_METHOD}`;

/** Build a mock request for the internal method, with optional headers. */
function internalReq(headers?: Headers) {
    return createMockRequest(headers ? { service: SERVICE, method: INTERNAL_METHOD, headers } : { service: SERVICE, method: INTERNAL_METHOD });
}

/** Capture the AuthContext seen inside next(). */
function capturingNext() {
    let seen: AuthContext | undefined;
    const next = createMockNext();
    const wrapped = async (req: unknown) => {
        seen = getAuthContext();
        return next(req);
    };
    return { next: wrapped, getSeen: () => seen, calls: () => next.mock.calls.length };
}

describe("internal-auth-interceptor", () => {
    describe("non-internal methods", () => {
        it("passes through untouched (no-op) when the method is not in internalMethods", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: () => null, // would reject everything if it ran
            });
            const cap = capturingNext();
            const handler = interceptor(cap.next as never);
            // A DIFFERENT method, not internal.
            const req = createMockRequest({ service: SERVICE, method: "PublicProbe" });

            await handler(req);

            assert.strictEqual(cap.calls(), 1, "next() called");
            assert.strictEqual(cap.getSeen(), undefined, "no AuthContext set for non-internal method");
        });
    });

    describe("missing / invalid marker", () => {
        it("rejects an internal call with no trust marker as Unauthenticated", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: sharedSecretTrust({ secret: "s3cr3t-value-32-bytes-minimum-xx" }),
            });
            const next = createMockNext();
            const handler = interceptor(next);

            await assert.rejects(
                () => handler(internalReq()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // A trust source that fails (synchronously, asynchronously, or with a non-Error value)
        // must fail the call closed as Unauthenticated: the caller learns nothing about the
        // internal failure and the handler never runs.
        const failingTrustSources: ReadonlyArray<readonly [string, () => never | Promise<never>]> = [
            [
                "throws synchronously",
                () => {
                    throw new Error("boom from trust source");
                },
            ],
            ["rejects asynchronously", () => Promise.reject(new Error("boom from trust source"))],
            [
                "throws a non-Error value",
                () => {
                    throw "boom from trust source";
                },
            ],
        ];
        for (const [label, failing] of failingTrustSources) {
            it(`maps a trust source that ${label} to Unauthenticated without leaking its text`, async () => {
                const interceptor = createInternalAuthInterceptor({
                    internalMethods: [INTERNAL_PATTERN],
                    trustSource: failing,
                });
                const next = createMockNext();
                const handler = interceptor(next);

                await assert.rejects(
                    () => handler(internalReq()),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        assert.ok(!err.message.includes("boom from trust source"), `client-visible message leaks the failure: ${err.message}`);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }
    });

    describe("meshIdentityTrust", () => {
        const PRINCIPAL = "cluster.local/ns/default/sa/trips";

        it("allows an allow-listed principal and sets its roles", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: meshIdentityTrust({
                    allowlist: [{ principal: PRINCIPAL, roles: ["worker"], scopes: ["trip:write"] }],
                }),
            });
            const cap = capturingNext();
            const handler = interceptor(cap.next as never);

            const headers = new Headers({ "x-forwarded-client-principal": PRINCIPAL });
            await handler(internalReq(headers));

            assert.strictEqual(cap.calls(), 1);
            const ctx = cap.getSeen();
            assert.ok(ctx, "AuthContext set");
            assert.strictEqual(ctx?.subject, PRINCIPAL);
            assert.deepStrictEqual([...(ctx?.roles ?? [])], ["worker"]);
            assert.deepStrictEqual([...(ctx?.scopes ?? [])], ["trip:write"]);
            assert.strictEqual(ctx?.type, "mesh");
            // Identity header stripped (anti-spoofing).
            assert.strictEqual(headers.get("x-forwarded-client-principal"), null);
        });

        it("reads the principal from the configured header and reports the configured type and name", async () => {
            const trust = meshIdentityTrust({ allowlist: [{ principal: PRINCIPAL, name: "Trips service" }], header: "x-peer", type: "spiffe" });

            assert.strictEqual(await trust(internalReq(new Headers({ "x-forwarded-client-principal": PRINCIPAL }))), null, "the default header is not read when another one is configured");
            const context = await trust(internalReq(new Headers({ "x-peer": PRINCIPAL })));
            assert.strictEqual(context?.type, "spiffe");
            assert.strictEqual(context?.name, "Trips service");
            assert.deepStrictEqual([...(context?.roles ?? ["unset"])], [], "an entry without roles grants none");
            assert.deepStrictEqual([...(context?.scopes ?? ["unset"])], [], "an entry without scopes grants none");
        });

        // Only an exact allow-list entry is admitted. The near-misses extend the allowed principal,
        // truncate it, change its case, swap one segment, or reuse a namespace, so a lookup that
        // matches by prefix, substring, length or case rejects none of them.
        for (const other of [
            "cluster.local/ns/default/sa/evil",
            `${PRINCIPAL}-evil`,
            `${PRINCIPAL}/extra`,
            PRINCIPAL.slice(0, -1),
            PRINCIPAL.toUpperCase(),
            "cluster.local/ns/other/sa/trips",
            "cluster.local/ns/default",
        ]) {
            it(`rejects the non-allow-listed principal ${JSON.stringify(other)} as Unauthenticated`, async () => {
                const interceptor = createInternalAuthInterceptor({
                    internalMethods: [INTERNAL_PATTERN],
                    trustSource: meshIdentityTrust({ allowlist: [{ principal: PRINCIPAL, roles: ["worker"] }] }),
                });
                const next = createMockNext();
                const handler = interceptor(next);

                const headers = new Headers({ "x-forwarded-client-principal": other });
                await assert.rejects(
                    () => handler(internalReq(headers)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
                // Header stripped even on rejection.
                assert.strictEqual(headers.get("x-forwarded-client-principal"), null);
            });
        }
    });

    describe("sharedSecretTrust (dev-only)", () => {
        const SECRET = "dev-only-shared-secret-please-rotate";

        it("allows a matching secret and assigns the configured identity", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: sharedSecretTrust({ secret: SECRET, subject: "internal-dev", roles: ["dev"] }),
            });
            const cap = capturingNext();
            const handler = interceptor(cap.next as never);

            const headers = new Headers({ "x-internal-secret": SECRET });
            await handler(internalReq(headers));

            assert.strictEqual(cap.calls(), 1);
            const ctx = cap.getSeen();
            assert.strictEqual(ctx?.subject, "internal-dev");
            assert.deepStrictEqual([...(ctx?.roles ?? [])], ["dev"]);
            assert.strictEqual(headers.get("x-internal-secret"), null, "secret header stripped");
        });

        // Near-misses of the configured secret: same length with one character changed, a prefix,
        // an extension, a case change, an unrelated value, and no header at all.
        const lastCharChanged = `${SECRET.slice(0, -1)}${SECRET.endsWith("x") ? "y" : "x"}`;
        for (const bad of ["wrong", `${SECRET}x`, SECRET.slice(0, -1), lastCharChanged, SECRET.toUpperCase(), undefined]) {
            it(`rejects the mismatched secret ${bad === undefined ? "(header absent)" : JSON.stringify(bad)} as Unauthenticated`, async () => {
                const interceptor = createInternalAuthInterceptor({
                    internalMethods: [INTERNAL_PATTERN],
                    trustSource: sharedSecretTrust({ secret: SECRET }),
                });
                const next = createMockNext();
                const handler = interceptor(next);

                await assert.rejects(
                    () => handler(internalReq(bad === undefined ? new Headers() : new Headers({ "x-internal-secret": bad }))),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

        it("strips the secret header even when the secret does not match", async () => {
            // The trust header must never travel on to the handler chain, whatever the outcome.
            const trust = sharedSecretTrust({ secret: SECRET });
            const headers = new Headers({ "x-internal-secret": "guessed-secret" });

            assert.strictEqual(await trust(internalReq(headers)), null);
            assert.strictEqual(headers.get("x-internal-secret"), null);
        });

        it("grants the documented default identity when only the secret is configured", async () => {
            const context = await sharedSecretTrust({ secret: SECRET })(internalReq(new Headers({ "x-internal-secret": SECRET })));

            assert.strictEqual(context?.subject, "internal");
            assert.strictEqual(context?.type, "internal");
            assert.deepStrictEqual([...(context?.roles ?? ["unset"])], []);
            assert.deepStrictEqual([...(context?.scopes ?? ["unset"])], []);
        });

        it("reads the secret from the configured header and grants the configured scopes and type", async () => {
            const trust = sharedSecretTrust({ secret: SECRET, header: "x-my-secret", scopes: ["trip:read"], type: "batch" });

            assert.strictEqual(await trust(internalReq(new Headers({ "x-internal-secret": SECRET }))), null, "the default header is not read when another one is configured");
            const context = await trust(internalReq(new Headers({ "x-my-secret": SECRET })));
            assert.deepStrictEqual([...(context?.scopes ?? [])], ["trip:read"]);
            assert.strictEqual(context?.type, "batch");
        });

        it("answers a value of a different length with null instead of throwing", async () => {
            // The trust source is a public building block. Comparing raw buffers of unequal length
            // would make the comparison itself throw, and the throw (versus a quiet rejection) would
            // tell a caller the length of the secret; the source must report a plain mismatch.
            const trust = sharedSecretTrust({ secret: SECRET });
            for (const value of ["x", SECRET.slice(0, -1), `${SECRET}x`, SECRET.repeat(3)]) {
                const result = await trust(internalReq(new Headers({ "x-internal-secret": value })));
                assert.strictEqual(result, null, `length ${value.length} must be a quiet mismatch`);
            }
        });
    });

    describe("signedTokenTrust — per-service issuer-bound JWKS", () => {
        const ISS_A = "service-a";
        const ISS_B = "service-b";
        const AUDIENCE = "internal-api";

        let kpA: RsaTestKeypair;
        let kpB: RsaTestKeypair;
        let jwksA: TestJwksServer;
        let jwksB: TestJwksServer;

        before(async () => {
            // DISTINCT kids per issuer — load-bearing for the containment test:
            // the forged token carries header kid = kid_A while claiming iss = B.
            kpA = await generateRsaTestKeypair("kid-service-a");
            kpB = await generateRsaTestKeypair("kid-service-b");
            jwksA = await startTestJwksServer(kpA.publicJwk);
            jwksB = await startTestJwksServer(kpB.publicJwk);
        });

        after(async () => {
            await jwksA.close();
            await jwksB.close();
        });

        function buildInterceptor() {
            return createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: signedTokenTrust({
                    issuers: {
                        [ISS_A]: { jwksUri: jwksA.url, audience: AUDIENCE, algorithms: ["RS256"], claimsMapping: { roles: "roles" } },
                        [ISS_B]: { jwksUri: jwksB.url, audience: AUDIENCE, algorithms: ["RS256"], claimsMapping: { roles: "roles" } },
                    },
                }),
            });
        }

        it("accepts a correctly self-signed B token and binds identity to B", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { sub: ISS_B, roles: ["worker"] }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            const handler = buildInterceptor()(cap.next as never);
            const headers = new Headers({ "x-internal-token": token });

            await handler(internalReq(headers));

            assert.strictEqual(cap.calls(), 1, "self-signed B token accepted");
            const ctx = cap.getSeen();
            assert.strictEqual(ctx?.subject, ISS_B, "identity bound to B");
            assert.strictEqual(ctx?.claims.iss, ISS_B);
            assert.deepStrictEqual([...(ctx?.roles ?? [])], ["worker"]);
            // The credential type defaults to "service" (documented default of the trust source).
            assert.strictEqual(ctx?.type, "service");
            assert.strictEqual(headers.get("x-internal-token"), null, "token header stripped");
            // The identity expires when the token does: exp (seconds) read from the token itself.
            const exp = jose.decodeJwt(token).exp;
            assert.ok(exp !== undefined, "the minted token carries exp");
            assert.strictEqual(ctx?.expiresAt?.getTime(), exp * 1000);
        });

        it("accepts only RS256 unless the issuer entry lists other algorithms", async () => {
            const { publicKey, privateKey } = await jose.generateKeyPair("RS384", { extractable: true });
            const jwks = await startTestJwksServer({ ...(await jose.exportJWK(publicKey)), kid: "kid-rs384", alg: "RS384", use: "sig" });
            try {
                const token = await new jose.SignJWT({})
                    .setProtectedHeader({ alg: "RS384", kid: "kid-rs384" })
                    .setIssuer(ISS_B)
                    .setAudience(AUDIENCE)
                    .setExpirationTime("1h")
                    .sign(privateKey);
                const trustFor = (algorithms?: string[]) => signedTokenTrust({ issuers: { [ISS_B]: { jwksUri: jwks.url, audience: AUDIENCE, algorithms } } });
                const present = () => internalReq(new Headers({ "x-internal-token": token }));

                assert.strictEqual(await trustFor()(present()), null, "an RS384 token is refused when the issuer entry sets no algorithms");
                assert.strictEqual(await trustFor(["RS256"])(present()), null, "an RS384 token is refused when only RS256 is listed");
                assert.strictEqual((await trustFor(["RS384"])(present()))?.subject, ISS_B, "the same token passes once RS384 is listed");
            } finally {
                await jwks.close();
            }
        });

        it("enforces the maximum token age of the issuer entry", async () => {
            const trust = signedTokenTrust({ issuers: { [ISS_B]: { jwksUri: jwksB.url, audience: AUDIENCE, maxTokenAge: "1h" } } });
            const signIssuedAgo = (ageSeconds: number) =>
                new jose.SignJWT({})
                    .setProtectedHeader({ alg: "RS256", kid: kpB.kid })
                    .setIssuer(ISS_B)
                    .setAudience(AUDIENCE)
                    .setIssuedAt(Math.floor(Date.now() / 1000) - ageSeconds)
                    .setExpirationTime("24h")
                    .sign(kpB.privateKey);

            const young = await signIssuedAgo(3000);
            const old = await signIssuedAgo(3900);
            assert.strictEqual((await trust(internalReq(new Headers({ "x-internal-token": young }))))?.subject, ISS_B);
            assert.strictEqual(await trust(internalReq(new Headers({ "x-internal-token": old }))), null);
        });

        // Whatever a caller puts into the token header, only a signed token of a configured issuer
        // opens the call; the header is removed in every case.
        for (const [label, value] of [
            ["a value that is not a JWT", "not-a-jwt"],
            ["three segments that do not form a JWT", "a.b.c"],
            ["a Bearer prefix with no token", "Bearer"],
            ["an unsecured token naming a configured issuer", new jose.UnsecuredJWT({}).setIssuer(ISS_B).setAudience(AUDIENCE).setExpirationTime("1h").encode()],
        ] as const) {
            it(`rejects ${label} and still strips the token header`, async () => {
                const next = createMockNext();
                const headers = new Headers({ "x-internal-token": value });

                await assert.rejects(
                    () => buildInterceptor()(next)(internalReq(headers)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
                assert.strictEqual(headers.get("x-internal-token"), null);
            });
        }

        it("identifies a verified token that carries no sub claim by its issuer, the configured service name", async () => {
            // No `sub`: the only identity left is the issuer the token was verified against, which is
            // the key of the service in the `issuers` configuration. Nothing from the token's other
            // claims may stand in for it.
            const token = await createTestJwtRS256(kpB.privateKey, { roles: ["worker"] }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            const handler = buildInterceptor()(cap.next as never);

            await handler(internalReq(new Headers({ "x-internal-token": token })));

            assert.strictEqual(cap.calls(), 1);
            assert.strictEqual(cap.getSeen()?.subject, ISS_B);
        });

        // The caller is the service whose own key signed the token. `sub` is a free-form claim the
        // issuer fills, so a token from B saying `sub: service-a` must not make B look like A.
        it("keeps the verified issuer as subject when the token's sub names another service", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { sub: ISS_A, roles: ["worker"] }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            await buildInterceptor()(cap.next as never)(internalReq(new Headers({ "x-internal-token": token })));

            assert.strictEqual(cap.calls(), 1);
            assert.strictEqual(cap.getSeen()?.subject, ISS_B);
            assert.strictEqual(cap.getSeen()?.claims.sub, ISS_A, "the raw claim stays available in claims, only the identity ignores it");
        });

        it("grants no scopes from the standard scope claim without a claimsMapping", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { scope: "trip:write admin" }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            // An issuer entry with no claimsMapping at all.
            const handler = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: signedTokenTrust({ issuers: { [ISS_B]: { jwksUri: jwksB.url, audience: AUDIENCE } } }),
            })(cap.next as never);
            await handler(internalReq(new Headers({ "x-internal-token": token })));

            assert.strictEqual(cap.calls(), 1);
            assert.deepStrictEqual([...(cap.getSeen()?.scopes ?? ["unset"])], []);
        });

        it("grants no scopes from the scope claim when the claimsMapping does not map scopes", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { scope: "trip:write", roles: ["worker"] }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            await buildInterceptor()(cap.next as never)(internalReq(new Headers({ "x-internal-token": token })));

            assert.strictEqual(cap.calls(), 1);
            assert.deepStrictEqual([...(cap.getSeen()?.scopes ?? ["unset"])], []);
            assert.deepStrictEqual([...(cap.getSeen()?.roles ?? [])], ["worker"]);
        });

        it("reads scopes and the subject from the claims an issuer entry maps explicitly", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { sub: "worker-7", scope: "trip:write trip:read" }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

            const cap = capturingNext();
            const handler = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: signedTokenTrust({
                    issuers: { [ISS_B]: { jwksUri: jwksB.url, audience: AUDIENCE, claimsMapping: { subject: "sub", scopes: "scope" } } },
                }),
            })(cap.next as never);
            await handler(internalReq(new Headers({ "x-internal-token": token })));

            assert.strictEqual(cap.calls(), 1);
            assert.strictEqual(cap.getSeen()?.subject, "worker-7");
            assert.deepStrictEqual([...(cap.getSeen()?.scopes ?? [])], ["trip:write", "trip:read"]);
        });

        for (const [label, claims] of [
            ["is absent", {}],
            ["is not a string", { sub: 42 }],
            ["is an empty string", { sub: "" }],
        ] as const) {
            it(`rejects the call when the explicitly mapped subject claim ${label}`, async () => {
                const token = await createTestJwtRS256(kpB.privateKey, { ...claims }, { kid: kpB.kid, issuer: ISS_B, audience: AUDIENCE });

                const next = createMockNext();
                const handler = createInternalAuthInterceptor({
                    internalMethods: [INTERNAL_PATTERN],
                    trustSource: signedTokenTrust({ issuers: { [ISS_B]: { jwksUri: jwksB.url, audience: AUDIENCE, claimsMapping: { subject: "sub" } } } }),
                })(next);

                await assert.rejects(
                    () => handler(internalReq(new Headers({ "x-internal-token": token }))),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

        it("rejects a token that is validly signed by the issuer's key but meant for another audience", async () => {
            const token = await createTestJwtRS256(kpB.privateKey, { sub: ISS_B }, { kid: kpB.kid, issuer: ISS_B, audience: "someone-else" });

            const next = createMockNext();
            const handler = buildInterceptor()(next);

            await assert.rejects(
                () => handler(internalReq(new Headers({ "x-internal-token": token }))),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // ====================================================================
        // HEADLINE CONTAINMENT TEST (ADR-029 §2 empirical finding):
        // A token claiming iss:B but signed with A's private key (header kid_A)
        // MUST be rejected as Unauthenticated. With issuer-bound JWKS, the iss:B
        // claim selects B's keyset (kid_B only) -> ERR_JWKS_NO_MATCHING_KEY.
        // ====================================================================
        it("REJECTS an A-signed token forged to claim iss:B (per-service containment)", async () => {
            // Signed with A's PRIVATE key, header kid = kid_A, but claims iss = B.
            const forged = await createTestJwtRS256(
                kpA.privateKey,
                { sub: ISS_B, roles: ["admin"] },
                { kid: kpA.kid, issuer: ISS_B, audience: AUDIENCE },
            );

            const next = createMockNext();
            const handler = buildInterceptor()(next);
            const headers = new Headers({ "x-internal-token": forged });

            await assert.rejects(
                () => handler(internalReq(headers)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0, "forged A-as-B token never reaches the handler");
        });

        it("also rejects the reverse forge (B-signed token claiming iss:A)", async () => {
            const forged = await createTestJwtRS256(kpB.privateKey, { sub: ISS_A, roles: ["admin"] }, { kid: kpB.kid, issuer: ISS_A, audience: AUDIENCE });

            const next = createMockNext();
            const handler = buildInterceptor()(next);
            const headers = new Headers({ "x-internal-token": forged });

            await assert.rejects(
                () => handler(internalReq(headers)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("rejects a token from an unconfigured issuer", async () => {
            const token = await createTestJwtRS256(kpA.privateKey, { sub: "service-c" }, { kid: kpA.kid, issuer: "service-c", audience: AUDIENCE });

            const next = createMockNext();
            const handler = buildInterceptor()(next);
            const headers = new Headers({ "x-internal-token": token });

            await assert.rejects(
                () => handler(internalReq(headers)),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // The published API reference of the token header states that its value "may be a bare
        // token or a `Bearer <token>` value"; the bare form is covered by the self-signed case above.
        it("accepts a Bearer-prefixed token value", async () => {
            const token = await createTestJwtRS256(kpA.privateKey, { sub: ISS_A }, { kid: kpA.kid, issuer: ISS_A, audience: AUDIENCE });

            const cap = capturingNext();
            const handler = buildInterceptor()(cap.next as never);
            const headers = new Headers({ "x-internal-token": `Bearer ${token}` });

            await handler(internalReq(headers));
            assert.strictEqual(cap.calls(), 1);
            assert.strictEqual(cap.getSeen()?.subject, ISS_A);
        });
    });

    describe("construction guards", () => {
        // A JavaScript consumer can bypass the types. An interceptor without a callable trust source
        // would either crash on the first internal call or, worse, be assumed protected, so the
        // factory refuses at configuration time and names the option.
        for (const [label, trustSource] of [
            ["missing", undefined],
            ["null", null],
            ["a string", "shared-secret"],
            ["an object", { header: "x-internal-secret" }],
        ] as const) {
            it(`throws naming trustSource when it is ${label}`, () => {
                assert.throws(
                    () => createInternalAuthInterceptor({ internalMethods: [INTERNAL_PATTERN], trustSource: trustSource as never }),
                    /trustSource/,
                );
            });
        }
        // An empty list would silently reject every caller; failing at construction exposes the
        // misconfiguration, and the message names the offending option.
        it("meshIdentityTrust throws on empty allowlist, naming allowlist", () => {
            assert.throws(() => meshIdentityTrust({ allowlist: [] }), /allowlist/);
        });
        it("signedTokenTrust throws with no issuers, naming issuer", () => {
            assert.throws(() => signedTokenTrust({ issuers: {} }), /issuer/);
        });
        it("sharedSecretTrust throws on empty secret", () => {
            assert.throws(() => sharedSecretTrust({ secret: "" }), /non-empty secret/);
        });
    });
});
