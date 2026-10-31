/**
 * A mistyped authorization policy must not open a method, on a real server and a real client.
 *
 * The chain is the shipped one: error handler, authentication, authorization. The first test
 * is the attack: a configuration value such as `"Deny"` or `"DENY"` (a typo, or an environment
 * variable in the wrong case) used to be read as "allow", so a signed-in caller reached a
 * method that no rule matched. Now the interceptor cannot be created, so a server with such a
 * configuration never starts. The parity tests then pin the valid values on both transports.
 */

import assert from "node:assert";
import { test } from "node:test";
import { Code } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { createAuthInterceptor, createAuthzInterceptor, createProtoAuthzInterceptor } from "../../src/index.ts";
import type { AuthzInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const signedIn = { authorization: "Bearer any" };

const authenticate = () =>
    createAuthInterceptor({
        verifyCredentials: async () => ({ subject: "alice", roles: [], scopes: [], claims: {}, type: "test" }),
    });

const authzFactories = [
    ["createAuthzInterceptor", createAuthzInterceptor],
    ["createProtoAuthzInterceptor", createProtoAuthzInterceptor],
] as const;

/** Start a real HTTP/2 server behind the given authorization options and call it as a signed-in user. */
async function callOverTheNetwork(factory: (options: AuthzInterceptorOptions) => ReturnType<typeof createAuthzInterceptor>, options: AuthzInterceptorOptions) {
    const server = createServer({
        services: [echoRoutes(Echo)],
        interceptors: [createErrorHandlerInterceptor({ logErrors: false }), authenticate(), factory(options)],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
    });
    await server.start();
    try {
        const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` });
        return await callEcho(Echo, transport, { headers: signedIn });
    } finally {
        await server.stop();
    }
}

for (const [name, factory] of authzFactories) {
    test(`${name}: a mistyped defaultPolicy never reaches a running server`, async () => {
        for (const policy of ["Deny", "DENY", "dney", "", null]) {
            await assert.rejects(
                () => callOverTheNetwork(factory, { defaultPolicy: policy as never }),
                (err: unknown) => err instanceof TypeError && /defaultPolicy must be "allow" or "deny"/.test(err.message),
                `defaultPolicy ${JSON.stringify(policy)} must be refused when the interceptor is created`,
            );
        }
    });

    test(`${name}: a mistyped rule effect never reaches a running server`, async () => {
        for (const effect of ["DENY", "block"]) {
            await assert.rejects(
                () => callOverTheNetwork(factory, { defaultPolicy: "deny", rules: [{ name: "block-all", methods: ["*"], effect: effect as never }] }),
                (err: unknown) => err instanceof TypeError && /rules\[0\]\.effect/.test(err.message),
                `effect ${JSON.stringify(effect)} must be refused when the interceptor is created`,
            );
        }
    });
}

const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });

transportParityTest("parity: defaultPolicy deny rejects an unmatched method on both transports", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), authenticate(), createAuthzInterceptor({ defaultPolicy: "deny" })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
    compare: (http, local) => {
        const expected = { code: Code.PermissionDenied, message: "Access denied by default policy" };
        assert.deepStrictEqual(http.error, expected, "HTTP");
        assert.deepStrictEqual(local.error, expected, "local");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: a deny rule with defaultPolicy allow rejects on both transports", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), authenticate(), createAuthzInterceptor({ defaultPolicy: "allow", rules: [{ name: "block-all", methods: ["*"], effect: "deny" }] })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
    compare: (http, local) => {
        const expected = { code: Code.PermissionDenied, message: "Access denied" };
        assert.deepStrictEqual(http.error, expected, "HTTP");
        assert.deepStrictEqual(local.error, expected, "local");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: defaultPolicy allow lets an unmatched method through on both transports", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), authenticate(), createAuthzInterceptor({ defaultPolicy: "allow" })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
    compare: (http, local) => {
        const expected = { text: 'handler ran as "alice"' };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
