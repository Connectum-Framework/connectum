/**
 * The JWT subject must be a non-empty string, on a real server and a real client.
 *
 * Each scenario signs a real token and sends it through the shipped
 * `createJwtAuthInterceptor`. The attacks are tokens that used to be accepted: a `sub` that is
 * an empty string carries no identity, and a number, boolean, array or object breaks the
 * `AuthContext.subject: string` contract (with `propagateHeaders` a number even ended the call
 * with `internal`).
 */

import assert from "node:assert";
import { Code } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });
const jwt = (options: Partial<JwtAuthInterceptorOptions> = {}) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, algorithms: ["HS256"], ...options });
const bearer = async (payload: Record<string, unknown>) => ({ authorization: `Bearer ${await createTestJwt(payload)}` });

function rejectedAs(message: string) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        const expected = { code: Code.Unauthenticated, message };
        assert.deepStrictEqual(http.error, expected, "HTTP");
        assert.deepStrictEqual(local.error, expected, "local");
        defaultCompare(http, local);
    };
}

for (const [label, sub] of [
    ["an empty string", ""],
    ["a number", 123],
    ["a boolean", true],
    ["an array", ["alice"]],
    ["an object", { id: "alice" }],
    ["null", null],
] as const) {
    for (const propagateHeaders of [false, true]) {
        transportParityTest(`parity: a token whose sub is ${label} is rejected (propagateHeaders ${propagateHeaders})`, {
            services: [echoRoutes(Echo)],
            interceptors: [errorHandler(), jwt({ propagateHeaders })],
            scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await bearer({ sub }) })) }),
            compare: rejectedAs("JWT missing subject claim"),
        });
    }
}

transportParityTest("parity: a mapped subject claim that is an empty string is rejected", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt({ claimsMapping: { subject: "uid" } })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await bearer({ uid: "", sub: "fallback" }) })) }),
    compare: rejectedAs("JWT missing subject claim"),
});

transportParityTest("parity: a mapped subject claim that is a string wins over sub", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt({ claimsMapping: { subject: "uid" } })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await bearer({ uid: "mapped-user", sub: "other" }) })) }),
    compare: (http, local) => {
        const expected = { text: 'handler ran as "mapped-user"' };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: a token with a string sub reaches the handler as that subject", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt({ propagateHeaders: true })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await bearer({ sub: "alice" }) })) }),
    compare: (http, local) => {
        const expected = { text: 'handler ran as "alice"' };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
