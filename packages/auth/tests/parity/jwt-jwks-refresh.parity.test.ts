/**
 * A key rotation and a key-set outage look the same over HTTP and in process.
 *
 * `jwks.cooldownDuration: 0` makes a token signed with a key that was just published acceptable at
 * once, where jose's default cooldown would reject it for 30 seconds. A key set that cannot be
 * fetched is reported as `Unauthenticated: Authentication failed`, the text of a bad token. Every
 * run of the scenario publishes a key of its own, so the two transports do not depend on each other.
 */

import assert from "node:assert";
import { after } from "node:test";
import { Code } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor } from "../../src/index.ts";
import { createTestJwtRS256, generateRsaTestKeypair } from "../../src/testing/index.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";
import { startSwappableJwks } from "../helpers/swappable-jwks.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const jwks = await startSwappableJwks();
after(() => jwks.close());

transportParityTest("parity: a freshly published key is accepted at once, an unpublished one and an unreachable key set are Unauthenticated", {
    services: [echoRoutes(Echo)],
    interceptors: [createErrorHandlerInterceptor({ logErrors: false }), createJwtAuthInterceptor({ jwksUri: jwks.url, algorithms: ["RS256"], jwks: { cooldownDuration: 0 } })],
    scenario: async ({ transport }) => {
        const published = await generateRsaTestKeypair(`published-${Math.random().toString(36).slice(2)}`);
        const unpublished = await generateRsaTestKeypair(`unpublished-${Math.random().toString(36).slice(2)}`);
        const bearer = async (key: typeof published) => ({ authorization: `Bearer ${await createTestJwtRS256(key.privateKey, { sub: "alice" }, { kid: key.kid })}` });

        jwks.publish([published.publicJwk]);
        const accepted = await callEcho(Echo, transport, { headers: await bearer(published) });
        const rejected = await callEcho(Echo, transport, { headers: await bearer(unpublished) });
        jwks.setMode("status-500");
        const outage = await callEcho(Echo, transport, { headers: await bearer(unpublished) });
        jwks.publish([published.publicJwk]);
        return { response: { accepted, rejected, outage } };
    },
    compare: (http, local) => {
        const unauthenticated = { error: { code: Code.Unauthenticated, message: "Authentication failed" } };
        const expected = { accepted: { response: { text: 'handler ran as "alice"' } }, rejected: unauthenticated, outage: unauthenticated };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
