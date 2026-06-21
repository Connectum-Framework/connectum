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
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
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

    it("generateRsaTestKeypair publishes a JWK with kid/alg/use", () => {
        assert.equal(keypair.kid, TEST_JWT_KID);
        assert.equal(keypair.publicJwk.kid, TEST_JWT_KID);
        assert.equal(keypair.publicJwk.alg, "RS256");
        assert.equal(keypair.publicJwk.use, "sig");
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
