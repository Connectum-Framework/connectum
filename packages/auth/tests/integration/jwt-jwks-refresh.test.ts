/**
 * Key rotation and outages of the remote key set behind `jwksUri`, against a real local JWKS endpoint.
 *
 * Without settings the interceptor takes jose's defaults: a token signed with a key that is not in
 * the cached key set triggers a refetch only after a 30 second cooldown, so right after a rotation
 * the new key is rejected and the retired key is still accepted from the cache. `jwks` shortens that
 * window. A key set that cannot be fetched (error status, garbage, no answer, a closed
 * port) is reported to the caller as the same `Unauthenticated: Authentication failed` as a bad token.
 */

import assert from "node:assert";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createTestJwtRS256, generateRsaTestKeypair, type RsaTestKeypair } from "../../src/testing/test-jwt-rs256.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";
import { type SwappableJwks, startSwappableJwks } from "../helpers/swappable-jwks.ts";

const REQ = { service: "test.Service", method: "Method" } as const;

let k1: RsaTestKeypair;
let k2: RsaTestKeypair;
let jwks: SwappableJwks;
const opened: SwappableJwks[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = (key: RsaTestKeypair) => createTestJwtRS256(key.privateKey, { sub: "user" }, { kid: key.kid });

/** Call an interceptor with `bearer` and report the subject the handler saw, or the error code and text. */
async function probe(interceptor: ReturnType<typeof createJwtAuthInterceptor>, bearer: string): Promise<string> {
    const req = createMockRequest(REQ);
    req.header.set("authorization", `Bearer ${bearer}`);
    try {
        await interceptor(createMockNext())(req);
        return "accepted";
    } catch (err) {
        assertConnectError(err, Code.Unauthenticated);
        return `Unauthenticated: ${err.rawMessage}`;
    }
}

const jwt = (extra: Partial<JwtAuthInterceptorOptions> = {}) => createJwtAuthInterceptor({ jwksUri: jwks.url, algorithms: ["RS256"], ...extra });

describe("remote key set: rotation and outages", () => {
    beforeEach(async () => {
        k1 = await generateRsaTestKeypair("k1");
        k2 = await generateRsaTestKeypair("k2");
        jwks = await startSwappableJwks([k1.publicJwk]);
        opened.push(jwks);
    });

    afterEach(async () => {
        await jwks.close();
    });

    after(async () => {
        await Promise.all(opened.map((server) => server.close()));
    });

    describe("rotation", () => {
        it("by default rejects the new key right after the rotation and still accepts the retired one from the cache", async () => {
            const interceptor = jwt();
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted");
            assert.strictEqual(jwks.hits(), 1);

            jwks.publish([k2.publicJwk]);

            assert.strictEqual(await probe(interceptor, await token(k2)), "Unauthenticated: Authentication failed", "the unknown key is inside the cooldown");
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted", "the retired key is still in the cache");
            assert.strictEqual(jwks.hits(), 1, "no refetch happened inside the default 30 s cooldown");
        });

        it("with cooldownDuration 0 accepts the new key at once and stops accepting the retired one", async () => {
            const interceptor = jwt({ jwks: { cooldownDuration: 0 } });
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted");

            jwks.publish([k2.publicJwk]);

            assert.strictEqual(await probe(interceptor, await token(k2)), "accepted");
            assert.strictEqual(jwks.hits(), 2, "the unknown key caused exactly one refetch");
            assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed");
        });

        it("with a short cooldownDuration accepts the new key once the cooldown has passed, not before", async () => {
            const interceptor = jwt({ jwks: { cooldownDuration: 1500 } });
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted");
            jwks.publish([k2.publicJwk]);

            assert.strictEqual(await probe(interceptor, await token(k2)), "Unauthenticated: Authentication failed");
            assert.strictEqual(jwks.hits(), 1);

            await sleep(1700);

            assert.strictEqual(await probe(interceptor, await token(k2)), "accepted");
            assert.strictEqual(jwks.hits(), 2);
        });

        it("with a short cacheMaxAge stops accepting a retired key once the cache has expired", async () => {
            const interceptor = jwt({ jwks: { cacheMaxAge: 300 } });
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted");
            jwks.publish([k2.publicJwk]);
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted", "inside the cache age the retired key is still served");

            await sleep(400);

            assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed");
            assert.strictEqual(jwks.hits(), 2, "the expired cache was fetched again");
        });
    });

    it("with cacheMaxAge 0 fetches the key set for every request, which is the price of a cache that never serves", async () => {
        const interceptor = jwt({ jwks: { cacheMaxAge: 0 } });
        for (let call = 1; call <= 3; call++) {
            assert.strictEqual(await probe(interceptor, await token(k1)), "accepted");
            assert.strictEqual(jwks.hits(), call, `request ${call} fetched the key set`);
        }
    });

    describe("outage", () => {
        for (const mode of ["status-500", "garbage"] as const) {
            it(`reports a key set that answers ${mode} as the same Unauthenticated as a bad token, and recovers when it is fixed`, async () => {
                jwks.setMode(mode);
                const interceptor = jwt();
                assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed");
                assert.ok(jwks.hits() >= 1);

                jwks.publish([k1.publicJwk]);
                assert.strictEqual(await probe(interceptor, await token(k1)), "accepted", "a failed fetch is not cached");
            });
        }

        it("treats an empty key set as a successful fetch: it is cached, and a key published later waits for the cooldown", async () => {
            jwks.setMode("empty-set");
            const interceptor = jwt();
            assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed");
            jwks.publish([k1.publicJwk]);
            assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed", "inside the default cooldown");
            assert.strictEqual(jwks.hits(), 1, "the empty key set was cached");

            const fast = jwt({ jwks: { cooldownDuration: 0 } });
            assert.strictEqual(await probe(fast, await token(k1)), "accepted", "cooldownDuration 0 recovers at once");
        });

        it("reports an endpoint that nobody listens on as Unauthenticated", async () => {
            const interceptor = jwt();
            await jwks.close();
            assert.strictEqual(await probe(interceptor, await token(k1)), "Unauthenticated: Authentication failed");
        });

        it("ends a request to an endpoint that never answers after timeoutDuration, as Unauthenticated", async () => {
            jwks.setMode("hang");
            const interceptor = jwt({ jwks: { timeoutDuration: 300 } });

            const started = performance.now();
            const outcome = await probe(interceptor, await token(k1));
            const elapsed = performance.now() - started;

            assert.strictEqual(outcome, "Unauthenticated: Authentication failed");
            assert.ok(elapsed >= 250, `waited for the timeout (${Math.round(elapsed)} ms)`);
            assert.ok(elapsed < 3000, `did not wait for the 5 s default (${Math.round(elapsed)} ms)`);
        });
    });
});
