/**
 * A scope that the next hop would split is not propagated, on both transports.
 *
 * Scopes travel in one header joined by single spaces and are split on a space when read, so
 * one granted scope that contains a space ("reports read admin") would arrive as three,
 * including a privilege nobody granted. With propagation on, the shipped JWT interceptor
 * rejects such an identity as Unauthenticated; with propagation off nothing is written and
 * the token is admitted with the scope as granted. The handler reports the scopes the next
 * hop would read from the headers, so a leak is visible in the response.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor, getAuthContext, parseAuthHeaders } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

/** Service whose handler reports the scopes granted here and the ones the next hop would read from the headers. */
function routes() {
    return defineService(AuthzService, {
        secureEcho: (_req, ctx) =>
            create(EchoResponseSchema, {
                // What the next hop would read from the propagated headers, and what this hop granted.
                message: JSON.stringify({ propagated: parseAuthHeaders(ctx.requestHeader)?.scopes ?? null, granted: getAuthContext()?.scopes }),
                subject: getAuthContext()?.subject ?? "",
            }),
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

/** Server chain: error handler, then the JWT interceptor reading scopes from an array claim. */
function chain(propagateHeaders: boolean) {
    return [
        createErrorHandlerInterceptor({ logErrors: false }),
        // The scopes come from a claim that holds an array, so one entry can contain a space.
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, claimsMapping: { scopes: "perms" }, propagateHeaders }),
    ];
}

/** One SecureEcho call with a token whose `perms` claim is `perms`, reported as a response or a rejection. */
async function call(transport: Parameters<typeof createClient>[1], perms: string[]): Promise<ParityScenarioResult> {
    try {
        const token = await createTestJwt({ sub: "alice", perms });
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: { authorization: `Bearer ${token}` },
        });
        return { response: JSON.parse(res.message) };
    } catch (err) {
        if (!(err instanceof ConnectError)) throw err;
        return { error: { code: err.code, message: err.rawMessage, details: [], metadata: {} } };
    }
}

transportParityTest("parity: a granted scope containing spaces is Unauthenticated when propagated, on both transports", {
    services: [routes()],
    interceptors: chain(true),
    scenario: async ({ transport }) => await call(transport, ["reports read admin"]),
    compare: (http, local) => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.ok(result.error, `${name} transport must reject, got ${JSON.stringify(result.response)}`);
            assert.strictEqual(result.error.code, Code.Unauthenticated, `${name} transport must reject with Unauthenticated`);
            assert.strictEqual(result.error.message, "Authentication failed");
        }
        defaultCompare(http, local);
    },
});

transportParityTest("parity: the same token is admitted with its scope as granted when propagation is off", {
    services: [routes()],
    interceptors: chain(false),
    scenario: async ({ transport }) => await call(transport, ["reports read admin"]),
    compare: (http, local) => {
        const expected = { propagated: null, granted: ["reports read admin"] };
        assert.deepStrictEqual(http.response, expected);
        assert.deepStrictEqual(local.response, expected);
        defaultCompare(http, local);
    },
});

transportParityTest("parity: scopes without spaces still round trip unchanged when propagated", {
    services: [routes()],
    interceptors: chain(true),
    scenario: async ({ transport }) => await call(transport, ["reports:read", "orders.write", "a\tb"]),
    compare: (http, local) => {
        const expected = { propagated: ["reports:read", "orders.write", "a\tb"], granted: ["reports:read", "orders.write", "a\tb"] };
        assert.deepStrictEqual(http.response, expected);
        assert.deepStrictEqual(local.response, expected);
        defaultCompare(http, local);
    },
});
