/**
 * An `authorize` callback that returns a truthy non-boolean does not let a call through,
 * on a real server and a real client.
 *
 * The callback is the one from the report: `(ctx) => ctx.claims.isAdmin`, where the verified
 * identity carries the claim as the string "false". The shipped authentication interceptor
 * produces the identity, the shipped authorization interceptor runs the callback, and the
 * client sees the outcome over HTTP/2 and in process.
 */

import assert from "node:assert";
import { Code } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { createAuthInterceptor, createAuthzInterceptor, createProtoAuthzInterceptor } from "../../src/index.ts";
import type { AuthContext } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const headers = { authorization: "Bearer any" };

const authenticateWith = (claims: Record<string, unknown>) =>
    createAuthInterceptor({
        verifyCredentials: async (): Promise<AuthContext> => ({ subject: "alice", roles: [], scopes: [], claims, type: "test" }),
    });

const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });

const authzFactories = [
    ["createAuthzInterceptor", createAuthzInterceptor],
    ["createProtoAuthzInterceptor", createProtoAuthzInterceptor],
] as const;

for (const [name, factory] of authzFactories) {
    for (const [label, claim] of [
        ['the string "false"', "false"],
        ['the string "0"', "0"],
        ["the number 1", 1],
        ["an object", {}],
    ] as const) {
        transportParityTest(`parity: ${name} denies when the callback returns ${label}`, {
            services: [echoRoutes(Echo)],
            interceptors: [errorHandler(), authenticateWith({ isAdmin: claim }), factory({ defaultPolicy: "deny", authorize: ((ctx: AuthContext) => ctx.claims.isAdmin) as never })],
            scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers })) }),
            compare: (http, local) => {
                const expected = { code: Code.PermissionDenied, message: "Access denied" };
                assert.deepStrictEqual(http.error, expected, "HTTP");
                assert.deepStrictEqual(local.error, expected, "local");
                defaultCompare(http, local);
            },
        });
    }

    transportParityTest(`parity: ${name} allows when the callback returns true`, {
        services: [echoRoutes(Echo)],
        interceptors: [errorHandler(), authenticateWith({ isAdmin: true }), factory({ defaultPolicy: "deny", authorize: ((ctx: AuthContext) => ctx.claims.isAdmin === true) as never })],
        scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers })) }),
        compare: (http, local) => {
            const expected = { text: 'handler ran as "alice"' };
            assert.deepStrictEqual(http.response, expected, "HTTP");
            assert.deepStrictEqual(local.response, expected, "local");
            defaultCompare(http, local);
        },
    });
}
