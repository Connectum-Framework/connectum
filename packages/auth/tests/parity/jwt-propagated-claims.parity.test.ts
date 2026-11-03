/**
 * `propagatedClaims` of the JWT interceptor limits what the next hop receives, on both transports.
 *
 * With `propagateHeaders` on, every claim of the verified token (email, phone, custom claims) is
 * written to `x-auth-claims`. `propagatedClaims` is the data-minimisation control for that header;
 * the JWT interceptor used to ignore it without an error, so the next hop received the whole token.
 * The handler reports the claims the next hop would read from the propagated headers.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor, parseAuthHeaders } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

/** Service whose handler reports the claims the next hop would read from the propagated headers. */
function routes() {
    return defineService(AuthzService, {
        secureEcho: (_req, ctx) => {
            // exp and iat change with every token; the filter is what the test is about.
            const { exp: _exp, iat: _iat, ...propagated } = parseAuthHeaders(ctx.requestHeader)?.claims ?? {};
            return create(EchoResponseSchema, { message: JSON.stringify({ propagated }) });
        },
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

/** Server chain: error handler, then the JWT interceptor with the given claim filter. */
function chain(propagatedClaims: string[] | undefined) {
    return [createErrorHandlerInterceptor({ logErrors: false }), createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagateHeaders: true, propagatedClaims })];
}

/** One SecureEcho call with a token that carries personal data and an organisation claim. */
async function call(transport: Parameters<typeof createClient>[1]): Promise<ParityScenarioResult> {
    const token = await createTestJwt({ sub: "user-1", email: "a@example.com", phone: "+10000000", org_id: "o1" });
    const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: { authorization: `Bearer ${token}` } });
    return { response: JSON.parse(res.message) };
}

/** Both transports must report exactly `expected` as the propagated claims. */
function expectPropagated(expected: Record<string, unknown>) {
    return (http: ParityScenarioResult, local: ParityScenarioResult) => {
        assert.deepStrictEqual(http.response, { propagated: expected }, "HTTP");
        assert.deepStrictEqual(local.response, { propagated: expected }, "local");
        defaultCompare(http, local);
    };
}

transportParityTest("parity: only the claims listed in propagatedClaims reach the next hop", {
    services: [routes()],
    interceptors: chain(["org_id"]),
    scenario: async ({ transport }) => await call(transport),
    compare: expectPropagated({ org_id: "o1" }),
});

transportParityTest("parity: every claim reaches the next hop when propagatedClaims is not set", {
    services: [routes()],
    interceptors: chain(undefined),
    scenario: async ({ transport }) => await call(transport),
    compare: expectPropagated({ sub: "user-1", email: "a@example.com", phone: "+10000000", org_id: "o1" }),
});

transportParityTest("parity: no claims header is written when propagatedClaims names none of the token's claims", {
    services: [routes()],
    interceptors: chain(["absent"]),
    scenario: async ({ transport }) => await call(transport),
    compare: expectPropagated({}),
});
