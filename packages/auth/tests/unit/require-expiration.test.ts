/**
 * A token without an `exp` claim.
 *
 * RFC 9068 section 2.2 requires `exp` in a JWT access token, and a signed token
 * without it never expires: a leaked one stays valid until the signing key is
 * rotated. RFC 7519 section 4.1.4 says a verifier that sees `exp` must reject the
 * token once that time has passed. So, by default, a token with no `exp` is
 * rejected and an expired one is rejected; `requireExpiration: false` is the
 * explicit opt-out for an issuer that cannot add it.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { SignJWT } from "jose";
import { createInternalAuthInterceptor, signedTokenTrust } from "../../src/internal-auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { generateRsaTestKeypair, type RsaTestKeypair, startTestJwksServer, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";

const REQUEST = { service: "test.Service", method: "Method" } as const;
const NOW = () => Math.floor(Date.now() / 1000);

type ExpirationCase = "absent" | "future" | "past";

/** Sign a token with the given `exp` situation. */
function hmacToken(exp: ExpirationCase): Promise<string> {
    const builder = new SignJWT({ sub: "user-1" }).setProtectedHeader({ alg: "HS256" });
    if (exp === "future") builder.setExpirationTime(NOW() + 3600);
    if (exp === "past") builder.setExpirationTime(NOW() - 60);
    return builder.sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

/** Whether the JWT interceptor lets the token through. */
async function jwtAdmits(token: string, requireExpiration?: boolean): Promise<boolean> {
    const interceptor = createJwtAuthInterceptor(requireExpiration === undefined ? { secret: TEST_JWT_SECRET } : { secret: TEST_JWT_SECRET, requireExpiration });
    const next = createMockNext();
    const req = createMockRequest(REQUEST);
    req.header.set("authorization", `Bearer ${token}`);
    try {
        await interceptor(next)(req);
    } catch (err) {
        assertConnectError(err, Code.Unauthenticated);
        return false;
    }
    return next.mock.calls.length === 1;
}

describe("createJwtAuthInterceptor: expiration", () => {
    it("rejects a token that has no exp claim by default", async () => {
        assert.strictEqual(await jwtAdmits(await hmacToken("absent")), false);
    });

    it("admits a token that has no exp claim only when requireExpiration is false", async () => {
        assert.strictEqual(await jwtAdmits(await hmacToken("absent"), false), true);
    });

    it("admits a token with a future exp", async () => {
        assert.strictEqual(await jwtAdmits(await hmacToken("future")), true);
    });

    it("rejects an expired token, also with requireExpiration false", async () => {
        assert.strictEqual(await jwtAdmits(await hmacToken("past")), false);
        assert.strictEqual(await jwtAdmits(await hmacToken("past"), false), false);
    });
});

describe("signedTokenTrust: expiration", () => {
    const ISSUER = "service-a";
    const AUDIENCE = "internal-api";
    let keypair: RsaTestKeypair;
    let jwks: TestJwksServer;

    before(async () => {
        keypair = await generateRsaTestKeypair("kid-exp");
        jwks = await startTestJwksServer(keypair.publicJwk);
    });

    after(async () => {
        await jwks.close();
    });

    function rsaToken(exp: ExpirationCase): Promise<string> {
        const builder = new SignJWT({ sub: ISSUER }).setProtectedHeader({ alg: "RS256", kid: keypair.kid }).setIssuer(ISSUER).setAudience(AUDIENCE);
        if (exp === "future") builder.setExpirationTime(NOW() + 3600);
        if (exp === "past") builder.setExpirationTime(NOW() - 60);
        return builder.sign(keypair.privateKey);
    }

    async function admits(token: string, requireExpiration?: boolean): Promise<boolean> {
        const issuer = { jwksUri: jwks.url, audience: AUDIENCE, algorithms: ["RS256"], ...(requireExpiration === undefined ? {} : { requireExpiration }) };
        const interceptor = createInternalAuthInterceptor({
            internalMethods: ["test.Service/Method"],
            trustSource: signedTokenTrust({ issuers: { [ISSUER]: issuer } }),
        });
        const next = createMockNext();
        const req = createMockRequest({ ...REQUEST, headers: new Headers({ "x-internal-token": token }) });
        try {
            await interceptor(next)(req);
        } catch (err) {
            assertConnectError(err, Code.Unauthenticated);
            return false;
        }
        return next.mock.calls.length === 1;
    }

    it("rejects a token that has no exp claim by default", async () => {
        assert.strictEqual(await admits(await rsaToken("absent")), false);
    });

    it("admits a token that has no exp claim only when the issuer sets requireExpiration to false", async () => {
        assert.strictEqual(await admits(await rsaToken("absent"), false), true);
    });

    it("admits a token with a future exp", async () => {
        assert.strictEqual(await admits(await rsaToken("future")), true);
    });

    it("rejects an expired token, also with requireExpiration false", async () => {
        assert.strictEqual(await admits(await rsaToken("past")), false);
        assert.strictEqual(await admits(await rsaToken("past"), false), false);
    });
});
