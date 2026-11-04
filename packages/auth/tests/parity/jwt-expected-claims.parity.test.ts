/**
 * Expected issuer, audience and token age of the JWT interceptor, on a real server and a real client.
 *
 * The attack is a configuration whose expected issuer or audience is an empty string, typically
 * `issuer: process.env.ISSUER ?? ""`. It used to switch the check off, so a token from any issuer
 * for any audience was accepted. Now such an interceptor cannot be created, so a server with that
 * configuration never starts; the configured checks keep rejecting a token from the wrong issuer
 * or for the wrong audience.
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
import { SignJWT } from "jose";
import { createJwtAuthInterceptor } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);
const errorHandler = () => createErrorHandlerInterceptor({ logErrors: false });
const jwt = (options: Partial<JwtAuthInterceptorOptions> = {}) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, algorithms: ["HS256"], ...options });
const bearer = async (payload: Record<string, unknown>, options?: Parameters<typeof createTestJwt>[1]) => ({ authorization: `Bearer ${await createTestJwt(payload, options)}` });

/** Start a real server behind the JWT interceptor and call it with a token from the wrong issuer and audience. */
async function callWithWrongIssuerAndAudience(options: Partial<JwtAuthInterceptorOptions>) {
    const interceptors = [errorHandler(), jwt(options)];
    const server = createServer({ services: [echoRoutes(Echo)], interceptors, port: 0, host: "127.0.0.1", allowHTTP1: false });
    await server.start();
    try {
        const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` });
        const headers = await bearer({ sub: "alice" }, { issuer: "https://evil.example", audience: "other-api" });
        return await callEcho(Echo, transport, { headers });
    } finally {
        await server.stop();
    }
}

test("an empty issuer or audience, or a zero maxTokenAge, never reaches a running server", async () => {
    for (const options of [{ issuer: "" }, { audience: "" }, { issuer: ["https://idp.example", ""] }, { audience: ["", "my-api"] }, { maxTokenAge: 0 }]) {
        await assert.rejects(
            () => callWithWrongIssuerAndAudience(options),
            (err: unknown) => (err instanceof TypeError || err instanceof RangeError) && /createJwtAuthInterceptor (issuer|audience|maxTokenAge) must/.test(err.message),
            `${JSON.stringify(options)} must be refused when the interceptor is created`,
        );
    }
});

test("a token from the wrong issuer or audience is rejected by the configured checks", async () => {
    for (const options of [{ issuer: "https://idp.example" }, { audience: "my-api" }, { issuer: [] }, { audience: [] }]) {
        assert.deepStrictEqual(await callWithWrongIssuerAndAudience(options), { error: { code: Code.Unauthenticated, message: "Authentication failed" } }, JSON.stringify(options));
    }
});

transportParityTest("parity: a token with the expected issuer and audience is accepted", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt({ issuer: "https://idp.example", audience: "my-api" })],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: await bearer({ sub: "alice" }, { issuer: "https://idp.example", audience: "my-api" }) })) }),
    compare: (http, local) => {
        const expected = { text: 'handler ran as "alice"' };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: a token older than maxTokenAge is rejected and a fresh one accepted", {
    services: [echoRoutes(Echo)],
    interceptors: [errorHandler(), jwt({ maxTokenAge: "1h" })],
    scenario: async ({ transport }) => {
        const old = await new SignJWT({ sub: "alice" })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 3600)
            .setExpirationTime("1h")
            .sign(new TextEncoder().encode(TEST_JWT_SECRET));
        const stale = await callEcho(Echo, transport, { headers: { authorization: `Bearer ${old}` } });
        const fresh = await callEcho(Echo, transport, { headers: await bearer({ sub: "alice" }) });
        return { response: { stale, fresh } };
    },
    compare: (http, local) => {
        const expected = {
            stale: { error: { code: Code.Unauthenticated, message: "Authentication failed" } },
            fresh: { response: { text: 'handler ran as "alice"' } },
        };
        assert.deepStrictEqual(http.response, expected, "HTTP");
        assert.deepStrictEqual(local.response, expected, "local");
        defaultCompare(http, local);
    },
});
