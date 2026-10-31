/**
 * An incomplete gateway or generic configuration is refused when the interceptor is created, not
 * on the first request, on a real server and a real client.
 *
 * The scenario is the one from the gateway guide: `expectedValues: [process.env.GATEWAY_SECRET]`
 * with the variable unset. The interceptor used to be created, the server started, and every call
 * ended with `internal error` and no hint. Now the server never starts, and a complete
 * configuration still serves.
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
import { createGatewayAuthInterceptor } from "../../src/index.ts";
import type { GatewayAuthInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });
const unsetVariable = process.env.CONNECTUM_TEST_GATEWAY_SECRET_THAT_IS_NOT_SET;

test("a gateway configuration built from an unset environment variable never reaches a running server", async () => {
    assert.strictEqual(unsetVariable, undefined, "the variable must be unset for this scenario");
    await assert.rejects(
        async () => {
            const gateway = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: { header: "x-gateway-secret", expectedValues: [unsetVariable] },
            } as unknown as GatewayAuthInterceptorOptions);
            const server = createServer({ services: [echoRoutes(Echo)], interceptors: [errorHandler(), gateway], port: 0, host: "127.0.0.1", allowHTTP1: false });
            await server.start();
            try {
                await callEcho(Echo, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` }), { headers: { "x-gateway-secret": "s", "x-user-id": "u" } });
            } finally {
                await server.stop();
            }
        },
        (err: unknown) => err instanceof TypeError && /trustSource\.expectedValues\[0\] must be a non-empty string/.test(err.message),
    );
});

transportParityTest("parity: a complete gateway configuration serves a trusted caller on both transports", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), createGatewayAuthInterceptor({ headerMapping: { subject: "x-user-id" }, trustSource: { header: "x-gateway-secret", expectedValues: ["shared-secret"] } })],
    scenario: async ({ transport }) => {
        const trusted = await callEcho(Echo, transport, { headers: { "x-gateway-secret": "shared-secret", "x-user-id": "alice" } });
        const untrusted = await callEcho(Echo, transport, { headers: { "x-gateway-secret": "wrong", "x-user-id": "alice" } });
        return { response: { trusted, untrusted } };
    },
    compare: (http, local) => {
        const expected = {
            trusted: { response: { text: 'handler ran as "alice"' } },
            untrusted: { error: { code: Code.Unauthenticated, message: "Untrusted request source" } },
        };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
