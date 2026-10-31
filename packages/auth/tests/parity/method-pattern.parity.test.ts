/**
 * A deny rule with a partial wildcard must not be silently inactive, on a real server and a real client.
 *
 * A wildcard inside a method name or a service name is not a supported pattern and matches no call. Such a deny
 * rule used to be accepted, so with `defaultPolicy: "allow"` the method stayed open. Now the
 * interceptor cannot be created, and the supported forms deny as written.
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
const authenticate = () => createAuthInterceptor({ verifyCredentials: async () => ({ subject: "alice", roles: [], scopes: [], claims: {}, type: "test" }) });
const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });

for (const [name, factory] of [
    ["createAuthzInterceptor", createAuthzInterceptor],
    ["createProtoAuthzInterceptor", createProtoAuthzInterceptor],
] as const) {
    test(`${name}: a deny rule with a partial wildcard never reaches a running server`, async () => {
        for (const pattern of ["acme.v1.Echo/Un*", "acme.v1.*/*"]) {
            const options: AuthzInterceptorOptions = { defaultPolicy: "allow", rules: [{ name: "keep-out", methods: [pattern], effect: "deny" }] };
            await assert.rejects(
                async () => {
                    const server = createServer({ services: [echoRoutes(Echo)], interceptors: [errorHandler(), authenticate(), factory(options)], port: 0, host: "127.0.0.1", allowHTTP1: false });
                    await server.start();
                    try {
                        await callEcho(Echo, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` }), { headers: signedIn });
                    } finally {
                        await server.stop();
                    }
                },
                (err: unknown) => err instanceof TypeError && /contains the unsupported method pattern/.test(err.message),
                `${pattern} must be refused when the interceptor is created`,
            );
        }
    });

    for (const pattern of ["acme.v1.Echo/Unary", "acme.v1.Echo/*", "*"]) {
        transportParityTest(`parity: ${name} denies through the supported pattern ${pattern}`, {
            services: [echoRoutes(Echo)],
            interceptors: [errorHandler(), authenticate(), factory({ defaultPolicy: "allow", rules: [{ name: "keep-out", methods: [pattern], effect: "deny" }] })],
            scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
            compare: (http, local) => {
                const expected = { code: Code.PermissionDenied, message: "Access denied" };
                assert.deepStrictEqual(http.error, expected, "HTTP");
                assert.deepStrictEqual(local.error, expected, "local");
                defaultCompare(http, local);
            },
        });
    }
}
