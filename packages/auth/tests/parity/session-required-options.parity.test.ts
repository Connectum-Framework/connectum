/**
 * A session interceptor without its callbacks never reaches a running server, and a complete one
 * serves, on a real server and a real client.
 *
 * Before, `createSessionAuthInterceptor({ mapSession })` was created, the server started, and every
 * call ended with "Session verification failed" whatever the credential.
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
import { createSessionAuthInterceptor } from "../../src/index.ts";
import type { SessionAuthInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });
const mapSession = async () => ({ subject: "alice", roles: [], scopes: [], claims: {}, type: "session" });

test("a session interceptor without verifySession never reaches a running server", async () => {
    await assert.rejects(
        async () => {
            const session = createSessionAuthInterceptor({ mapSession } as unknown as SessionAuthInterceptorOptions);
            const server = createServer({ services: [echoRoutes(Echo)], interceptors: [errorHandler(), session], port: 0, host: "127.0.0.1", allowHTTP1: false });
            await server.start();
            try {
                await callEcho(Echo, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` }), { headers: { authorization: "Bearer s" } });
            } finally {
                await server.stop();
            }
        },
        (err: unknown) => err instanceof TypeError && /createSessionAuthInterceptor verifySession must be a function/.test(err.message),
    );
});

transportParityTest("parity: a complete session interceptor serves a valid session and rejects a failed one on both transports", {
    services: [echoRoutes(Echo)],
    interceptors: [
        errorHandler(),
        createSessionAuthInterceptor({
            verifySession: async (token) => {
                if (token !== "valid") throw new Error("no such session");
                return {};
            },
            mapSession,
        }),
    ],
    scenario: async ({ transport }) => {
        const valid = await callEcho(Echo, transport, { headers: { authorization: "Bearer valid" } });
        const invalid = await callEcho(Echo, transport, { headers: { authorization: "Bearer other" } });
        return { response: { valid, invalid } };
    },
    compare: (http, local) => {
        const expected = {
            valid: { response: { text: 'handler ran as "alice"' } },
            invalid: { error: { code: Code.Unauthenticated, message: "Session verification failed" } },
        };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
