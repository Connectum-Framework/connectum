/**
 * A refusal of access is never answered with the fallback value, on both transports.
 *
 * The server chain is the one that exposes the problem: the fallback interceptor stands
 * OUTSIDE the authentication interceptor, so the authentication refusal travels through it.
 * The shipped `createFallbackInterceptor()` and `createJwtAuthInterceptor()` are used; a
 * stand-in would stay green while the shipped ones changed what a client receives.
 *
 * Each scenario checks the outcome against a literal and then compares the two transports.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor, createFallbackInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

const FALLBACK_MESSAGE = "FALLBACK-VALUE";

function routes() {
    return defineService(AuthzService, {
        secureEcho: (req) => create(EchoResponseSchema, { message: `secure:${req.message}`, subject: getAuthContext()?.subject ?? "" }),
        publicEcho: (req) => create(EchoResponseSchema, { message: `public:${req.message}` }),
    });
}

/** Fallback outside authentication: the refusal of the inner interceptor passes through the fallback. */
function chain() {
    return [
        createErrorHandlerInterceptor({ logErrors: false }),
        createFallbackInterceptor({ handler: () => create(EchoResponseSchema, { message: FALLBACK_MESSAGE }) }),
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET }),
    ];
}

function describeRejection(err: unknown): NonNullable<ParityScenarioResult["error"]> {
    if (!(err instanceof ConnectError)) {
        return { code: "non-connect", message: String(err) };
    }
    return { code: err.code, message: err.rawMessage, details: [], metadata: {} };
}

transportParityTest("parity: a call without credentials is Unauthenticated, not the fallback value, on both transports", {
    services: [routes()],
    interceptors: chain(),
    scenario: async ({ transport }) => {
        try {
            const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "hello" }));
            return { response: { message: res.message } };
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.response, undefined, `${name} transport must not answer with the fallback value`);
            assert.ok(result.error, `${name} transport must surface the refusal`);
            assert.strictEqual(result.error.code, Code.Unauthenticated, `${name} transport must reject with Unauthenticated`);
        }
        defaultCompare(http, local);
    },
});

transportParityTest("parity: a call with valid credentials reaches the real handler, not the fallback, on both transports", {
    services: [routes()],
    interceptors: chain(),
    scenario: async ({ transport }) => {
        const token = await createTestJwt({ sub: "alice" });
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "hello" }), {
            headers: { authorization: `Bearer ${token}` },
        });
        return { response: { message: res.message, subject: res.subject } };
    },
    compare: (http, local) => {
        const expected = { message: "secure:hello", subject: "alice" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must serve the call by the real handler");
        assert.deepStrictEqual(local.response, expected, "Local transport must serve the call by the real handler");
        defaultCompare(http, local);
    },
});
