/**
 * Unit tests for the RS256 + JWKS test helpers.
 *
 * Drives the helpers through the PRODUCTION `jwksUri` branch of
 * `createJwtAuthInterceptor` (`createRemoteJWKSet`) — the same path an external
 * IdP (Ory Oathkeeper, Auth0, …) exercises — so the helpers are proven against
 * real verification, not a stub.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/testing";
import { decodeJwt } from "jose";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwt } from "../../src/testing/test-jwt.ts";
import { createTestJwtRS256, generateRsaTestKeypair, type RsaTestKeypair, startTestJwksServer, TEST_JWT_KID, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";

const REQ = { service: "test.Service", method: "Method" } as const;
const ISSUER = "https://issuer.example";
const AUDIENCE = "test-api";

describe("testing/test-jwt-rs256", () => {
    let keypair: RsaTestKeypair;
    let jwks: TestJwksServer;

    before(async () => {
        keypair = await generateRsaTestKeypair();
        jwks = await startTestJwksServer(keypair.publicJwk);
    });

    after(async () => {
        await jwks.close();
    });

    const jwtInterceptor = () =>
        createJwtAuthInterceptor({
            jwksUri: jwks.url,
            issuer: ISSUER,
            audience: AUDIENCE,
            algorithms: ["RS256"],
            claimsMapping: { roles: "roles" },
        });

    it("generateRsaTestKeypair publishes a public RSA JWK with kid/alg/use and no private material", () => {
        const jwk = keypair.publicJwk;
        // The documented default key id.
        assert.equal(TEST_JWT_KID, "connectum-test-key");
        assert.equal(keypair.kid, "connectum-test-key");
        assert.equal(jwk.kid, "connectum-test-key");
        // RFC 7517 section 4: alg and use name the intended algorithm and use.
        assert.equal(jwk.alg, "RS256");
        assert.equal(jwk.use, "sig");
        // RFC 7518 section 6.3.1: an RSA public key carries kty, modulus n and exponent e.
        assert.equal(jwk.kty, "RSA");
        assert.equal(jwk.e, "AQAB");
        // RFC 7518 section 3.3: RS256 requires a key of 2048 bits or more.
        assert.ok(jwk.n);
        assert.ok(Buffer.from(jwk.n, "base64url").length >= 256, "modulus must be at least 2048 bits");
        // RFC 7518 section 6.3.2: these members are private-key parameters and must never be published.
        for (const privateMember of ["d", "p", "q", "dp", "dq", "qi"]) {
            assert.equal(privateMember in jwk, false, `public JWK must not carry "${privateMember}"`);
        }
    });

    it("generateRsaTestKeypair stamps a custom kid on the keypair and on the public JWK", async () => {
        const custom = await generateRsaTestKeypair("custom-key-id");
        assert.equal(custom.kid, "custom-key-id");
        assert.equal(custom.publicJwk.kid, "custom-key-id");
    });

    it("startTestJwksServer serves the public key at /.well-known/jwks.json", async () => {
        const res = await fetch(jwks.url);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { keys: Array<{ kid?: string }> };
        assert.equal(body.keys.length, 1);
        assert.equal(body.keys[0]?.kid, TEST_JWT_KID);
    });

    it("a minted RS256 token validates through createJwtAuthInterceptor({ jwksUri }) and populates the AuthContext", async () => {
        let ctx: ReturnType<typeof getAuthContext>;
        const next = async () => {
            ctx = getAuthContext();
            return { message: {} };
        };
        // biome-ignore lint/suspicious/noExplicitAny: minimal next stub for the interceptor under test
        const handler = jwtInterceptor()(next as any);

        const token = await createTestJwtRS256(keypair.privateKey, { sub: "user-123", roles: ["admin"] }, { kid: keypair.kid, issuer: ISSUER, audience: AUDIENCE });
        const req = createMockRequest(REQ);
        req.header.set("authorization", `Bearer ${token}`);
        // biome-ignore lint/suspicious/noExplicitAny: mock request
        await handler(req as any);

        // biome-ignore lint/style/noNonNullAssertion: set by the handler above
        assert.equal(ctx!.subject, "user-123");
        // biome-ignore lint/style/noNonNullAssertion: set by the handler above
        assert.deepEqual(ctx!.roles, ["admin"]);
    });

    it("rejects a token with the wrong issuer", async () => {
        // biome-ignore lint/suspicious/noExplicitAny: minimal next stub for the interceptor under test
        const handler = jwtInterceptor()((async () => ({ message: {} })) as any);
        const token = await createTestJwtRS256(keypair.privateKey, { sub: "u" }, { kid: keypair.kid, issuer: "https://evil.example", audience: AUDIENCE });
        const req = createMockRequest(REQ);
        req.header.set("authorization", `Bearer ${token}`);
        // biome-ignore lint/suspicious/noExplicitAny: mock request
        await assert.rejects(handler(req as any), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });

    it("rejects a token whose kid names no published key even though the published key signed it", async () => {
        // A valid signature is not enough: the verifier selects the key by kid (RFC 7515 section 4.1.4),
        // and a kid that the JWKS does not list leaves it with no key to verify against.
        const handler = jwtInterceptor()((async () => ({ message: {} })) as never);
        const token = await createTestJwtRS256(keypair.privateKey, { sub: "u" }, { kid: "unlisted-kid", issuer: ISSUER, audience: AUDIENCE });
        const req = createMockRequest(REQ);
        req.header.set("authorization", `Bearer ${token}`);
        await assert.rejects(handler(req), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });

    it("mints tokens that expire in one hour unless another lifetime is asked for", async () => {
        // The helpers' documented default for `expiresIn` is "1h".
        const lifetimeOf = (token: string): number => {
            const { exp, iat } = decodeJwt(token);
            assert.ok(exp !== undefined && iat !== undefined, "the minted token carries exp and iat");
            return exp - iat;
        };

        // iat and exp are read from the clock separately, so a second boundary between the two reads adds one second.
        const assertLifetime = (actual: number, expected: number): void => {
            assert.ok(actual === expected || actual === expected + 1, `lifetime ${actual}s, expected ${expected}s`);
        };

        assertLifetime(lifetimeOf(await createTestJwtRS256(keypair.privateKey, { sub: "u" }, { kid: keypair.kid })), 3600);
        assertLifetime(lifetimeOf(await createTestJwtRS256(keypair.privateKey, { sub: "u" }, { kid: keypair.kid, expiresIn: "2h" })), 7200);
        assertLifetime(lifetimeOf(await createTestJwt({ sub: "u" })), 3600);
        assertLifetime(lifetimeOf(await createTestJwt({ sub: "u" }, { expiresIn: "2h" })), 7200);
    });

    it("rejects a token signed by an unpublished key (kid mismatch / bad signature)", async () => {
        // biome-ignore lint/suspicious/noExplicitAny: minimal next stub for the interceptor under test
        const handler = jwtInterceptor()((async () => ({ message: {} })) as any);
        const other = await generateRsaTestKeypair("other-key");
        const token = await createTestJwtRS256(other.privateKey, { sub: "u" }, { kid: keypair.kid, issuer: ISSUER, audience: AUDIENCE });
        const req = createMockRequest(REQ);
        req.header.set("authorization", `Bearer ${token}`);
        // biome-ignore lint/suspicious/noExplicitAny: mock request
        await assert.rejects(handler(req as any), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });
});
