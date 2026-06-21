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

        it("maps a throwing trust source to Unauthenticated (never leaks as Internal)", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: () => {
                    throw new Error("boom from trust source");
                },
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

        it("rejects a non-allow-listed principal as Unauthenticated", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: meshIdentityTrust({ allowlist: [{ principal: PRINCIPAL, roles: ["worker"] }] }),
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const headers = new Headers({ "x-forwarded-client-principal": "cluster.local/ns/default/sa/evil" });
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

        it("rejects a mismatched secret (and a length mismatch does not throw a length oracle)", async () => {
            const interceptor = createInternalAuthInterceptor({
                internalMethods: [INTERNAL_PATTERN],
                trustSource: sharedSecretTrust({ secret: SECRET }),
            });
            const next = createMockNext();
            const handler = interceptor(next);

            for (const bad of ["wrong", `${SECRET}x`, ""]) {
                const headers = new Headers(bad === "" ? {} : { "x-internal-secret": bad });
                await assert.rejects(
                    () => handler(internalReq(headers)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
            }
            assert.strictEqual(next.mock.calls.length, 0);
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
            assert.strictEqual(headers.get("x-internal-token"), null, "token header stripped");
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
        it("throws when trustSource is missing", () => {
            assert.throws(
                // @ts-expect-error intentionally missing trustSource
                () => createInternalAuthInterceptor({ internalMethods: [INTERNAL_PATTERN] }),
                /requires a trustSource/,
            );
        });
        it("meshIdentityTrust throws on empty allowlist", () => {
            assert.throws(() => meshIdentityTrust({ allowlist: [] }), /non-empty allowlist/);
        });
        it("signedTokenTrust throws with no issuers", () => {
            assert.throws(() => signedTokenTrust({ issuers: {} }), /at least one issuer/);
        });
        it("sharedSecretTrust throws on empty secret", () => {
            assert.throws(() => sharedSecretTrust({ secret: "" }), /non-empty secret/);
        });
    });
});
