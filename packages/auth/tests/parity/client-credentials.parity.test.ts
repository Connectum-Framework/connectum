/**
 * Client credential interceptors never send the text "undefined" or "null" as a credential, on a
 * real server and a real client.
 *
 * The server echoes the `authorization` and `x-gateway-secret` headers it received. A token that
 * resolves to `undefined` or `null` (an unset environment variable, a refresh that failed and
 * returned nothing) used to arrive as `Bearer undefined` or `Bearer null`, and the server then
 * rejected the call as an invalid credential, far from the missing configuration. Now the call
 * fails on the client with a message that names the interceptor, and nothing is sent.
 */

import assert from "node:assert";
import { test } from "node:test";
import { Code } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createClientBearerInterceptor, createClientGatewayInterceptor } from "../../src/index.ts";
import { callEcho, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary" }]);

/** Counts the calls that reached the handler and echoes the credential headers they carried. */
function recordingRoutes() {
    const received: Array<{ authorization: string | null; gatewaySecret: string | null }> = [];
    const routes = defineService(Echo as never, {
        unary: (_request: unknown, context: { requestHeader: Headers }) => {
            received.push({ authorization: context.requestHeader.get("authorization"), gatewaySecret: context.requestHeader.get("x-gateway-secret") });
            return { text: `authorization=${context.requestHeader.get("authorization")};secret=${context.requestHeader.get("x-gateway-secret")}` };
        },
    } as never);
    return { routes, received };
}

const notAToken: Array<[string, () => unknown]> = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["an empty string", () => ""],
    ["a number", () => 42],
    ["an object", () => ({ token: "abc" })],
];

test("a static token that is not a non-empty string is refused when the interceptor is created", () => {
    for (const token of [undefined, null, "", 42, {}]) {
        assert.throws(
            () => createClientBearerInterceptor({ token: token as never }),
            (err: unknown) => err instanceof TypeError && /createClientBearerInterceptor token must be a non-empty string or a function that returns one/.test(err.message),
            `token ${JSON.stringify(token)}`,
        );
    }
});

for (const [label, produce] of notAToken) {
    const { routes, received } = recordingRoutes();
    transportParityTest(`parity: a token factory that returns ${label} fails the call on the client and sends nothing`, {
        services: [routes],
        clientInterceptors: [createClientBearerInterceptor({ token: (async () => produce()) as never })],
        scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport)) }),
        compare: (http: ParityScenarioResult, local: ParityScenarioResult) => {
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                assert.strictEqual(result.error?.code, Code.Unauthenticated, name);
                assert.match(String(result.error?.message), /createClientBearerInterceptor token factory returned .+; expected a non-empty string/, name);
            }
            assert.strictEqual(received.length, 0, "no request may reach the server");
            defaultCompare(http, local);
        },
    });
}

{
    const { routes } = recordingRoutes();
    transportParityTest("parity: a static token and a refreshing factory are sent as Bearer tokens", {
        services: [routes],
        clientInterceptors: [createClientBearerInterceptor({ token: "static-token" })],
        scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport)) }),
        compare: (http, local) => {
            const expected = { text: "authorization=Bearer static-token;secret=null" };
            assert.deepStrictEqual(http.response, expected, "HTTP");
            assert.deepStrictEqual(local.response, expected, "local");
            defaultCompare(http, local);
        },
    });
}

{
    const { routes } = recordingRoutes();
    let issued = 0;
    transportParityTest("parity: the token factory runs before every call", {
        services: [routes],
        clientInterceptors: [createClientBearerInterceptor({ token: async () => `fresh-${++issued}` })],
        scenario: async ({ transport }) => {
            const first = await callEcho(Echo, transport);
            const second = await callEcho(Echo, transport);
            return { response: { first, second } };
        },
        compare: (http, local) => {
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                const { first, second } = result.response as { first: { response: { text: string } }; second: { response: { text: string } } };
                assert.match(first.response.text, /^authorization=Bearer fresh-\d+;/, name);
                assert.match(second.response.text, /^authorization=Bearer fresh-\d+;/, name);
                assert.notStrictEqual(first.response.text, second.response.text, `${name}: two calls, two tokens`);
            }
        },
    });
}

test("a gateway client secret or subject that is not a non-empty string is refused when the interceptor is created", () => {
    for (const secret of [undefined, null, "", 42]) {
        assert.throws(
            () => createClientGatewayInterceptor({ secret: secret as never, subject: "order-service" }),
            (err: unknown) => err instanceof TypeError && /createClientGatewayInterceptor secret must be a non-empty string/.test(err.message),
            `secret ${JSON.stringify(secret)}`,
        );
    }
    for (const subject of [undefined, null, "", 42]) {
        assert.throws(
            () => createClientGatewayInterceptor({ secret: "s", subject: subject as never }),
            (err: unknown) => err instanceof TypeError && /createClientGatewayInterceptor subject must be a non-empty string/.test(err.message),
            `subject ${JSON.stringify(subject)}`,
        );
    }
});

{
    const { routes } = recordingRoutes();
    transportParityTest("parity: the gateway client sends the secret it was given", {
        services: [routes],
        clientInterceptors: [createClientGatewayInterceptor({ secret: "shared-secret", subject: "order-service" })],
        scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport)) }),
        compare: (http, local) => {
            const expected = { text: "authorization=null;secret=shared-secret" };
            assert.deepStrictEqual(http.response, expected, "HTTP");
            assert.deepStrictEqual(local.response, expected, "local");
            defaultCompare(http, local);
        },
    });
}
