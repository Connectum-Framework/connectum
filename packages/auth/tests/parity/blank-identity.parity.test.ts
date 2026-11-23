/**
 * An identity whose subject holds nothing but control characters is Unauthenticated on both
 * transports, and the handler never runs.
 *
 * Control characters are removed from a subject when it is written to or read from an `x-auth-*`
 * header, so such a subject is empty in every sense that matters downstream. The generic
 * interceptor must reject it from a verifier result whether or not headers are propagated, and the
 * gateway interceptor must reject it when the subject header carries only control characters (sent
 * percent-encoded, since an HTTP header cannot hold them raw). The shipped interceptors run behind
 * the error handler; a well-formed identity still reaches the handler, so the refusal is not a
 * blanket one.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { AUTH_HEADERS, createAuthInterceptor, createGatewayAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

/** A subject that is empty once the control characters (C0 and DEL) are removed. */
const CONTROLS_ONLY = "\x01\x0E\x7F";
const EDGE_SECRET = "edge-secret";

/** Counts handler runs, so a call that wrongly gets through is visible even if the client ignores the body. */
function routes(runs: { count: number }) {
    return defineService(AuthzService, {
        secureEcho: () => {
            runs.count++;
            return create(EchoResponseSchema, { message: "reached", subject: getAuthContext()?.subject ?? "" });
        },
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

/** One SecureEcho call, reported as a response or as the rejection the client sees. */
async function call(transport: Parameters<typeof createClient>[1], headers: Record<string, string>): Promise<ParityScenarioResult> {
    try {
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), { headers });
        return { response: { message: res.message, subject: res.subject } };
    } catch (err) {
        if (!(err instanceof ConnectError)) throw err;
        return { error: { code: err.code, message: err.rawMessage, details: [], metadata: {} } };
    }
}

/** Oracle: both transports reject with Unauthenticated and `message`, the handler never ran, and the results are equal. */
function expectRefused(message: string, runs: { count: number }) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.ok(result.error, `${name} transport must reject, got ${JSON.stringify(result.response)}`);
            assert.strictEqual(result.error.code, Code.Unauthenticated, `${name} transport must reject with Unauthenticated`);
            assert.strictEqual(result.error.message, message, `${name} transport must deliver the rejection text`);
        }
        assert.strictEqual(runs.count, 0, "the handler must not run for an identity without a subject");
        defaultCompare(http, local);
    };
}

for (const propagateHeaders of [true, false]) {
    const runs = { count: 0 };
    transportParityTest(`parity: verifyCredentials returning a control-characters-only subject is Unauthenticated on both transports (propagateHeaders: ${propagateHeaders})`, {
        services: [routes(runs)],
        interceptors: [
            createErrorHandlerInterceptor({ logErrors: false }),
            createAuthInterceptor({
                verifyCredentials: async () => ({ subject: CONTROLS_ONLY, type: "jwt", roles: [], scopes: [], claims: {} }),
                propagateHeaders,
            }),
        ],
        scenario: async ({ transport }) => await call(transport, { authorization: "Bearer any-token" }),
        compare: expectRefused("Authentication failed", runs),
    });
}

transportParityTest("parity: verifyCredentials returning an ordinary subject still reaches the handler on both transports", {
    services: [routes({ count: 0 })],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createAuthInterceptor({ verifyCredentials: async () => ({ subject: "alice", type: "jwt", roles: [], scopes: [], claims: {} }) }),
    ],
    scenario: async ({ transport }) => await call(transport, { authorization: "Bearer any-token" }),
    compare: (http, local) => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.deepStrictEqual(result.response, { message: "reached", subject: "alice" }, `${name} transport must admit an ordinary subject`);
        }
        defaultCompare(http, local);
    },
});

{
    const runs = { count: 0 };
    transportParityTest("parity: a gateway subject header holding only control characters is Unauthenticated on both transports", {
        services: [routes(runs)],
        interceptors: [
            createErrorHandlerInterceptor({ logErrors: false }),
            createGatewayAuthInterceptor({
                headerMapping: { subject: AUTH_HEADERS.SUBJECT },
                trustSource: { header: "x-edge-secret", expectedValues: [EDGE_SECRET] },
            }),
        ],
        scenario: async ({ transport }) =>
            await call(transport, {
                "x-edge-secret": EDGE_SECRET,
                [AUTH_HEADERS.ENCODING]: "percent-utf8",
                [AUTH_HEADERS.SUBJECT]: `utf-8''${encodeURIComponent(CONTROLS_ONLY)}`,
            }),
        compare: expectRefused("Missing subject header from gateway", runs),
    });
}

transportParityTest("parity: a gateway subject header with an ordinary subject still reaches the handler on both transports", {
    services: [routes({ count: 0 })],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createGatewayAuthInterceptor({
            headerMapping: { subject: AUTH_HEADERS.SUBJECT },
            trustSource: { header: "x-edge-secret", expectedValues: [EDGE_SECRET] },
        }),
    ],
    scenario: async ({ transport }) => await call(transport, { "x-edge-secret": EDGE_SECRET, [AUTH_HEADERS.SUBJECT]: "alice" }),
    compare: (http, local) => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.deepStrictEqual(result.response, { message: "reached", subject: "alice" }, `${name} transport must admit an ordinary subject`);
        }
        defaultCompare(http, local);
    },
});

transportParityTest("parity: a gateway type header holding only control characters falls back to the default type on both transports", {
    services: [
        defineService(AuthzService, {
            secureEcho: () => create(EchoResponseSchema, { message: getAuthContext()?.type ?? "", subject: getAuthContext()?.subject ?? "" }),
            publicEcho: () => create(EchoResponseSchema, { message: "public" }),
        }),
    ],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createGatewayAuthInterceptor({
            headerMapping: { subject: AUTH_HEADERS.SUBJECT, type: AUTH_HEADERS.TYPE },
            trustSource: { header: "x-edge-secret", expectedValues: [EDGE_SECRET] },
            defaultType: "edge-default",
        }),
    ],
    scenario: async ({ transport }) =>
        await call(transport, {
            "x-edge-secret": EDGE_SECRET,
            [AUTH_HEADERS.ENCODING]: "percent-utf8",
            [AUTH_HEADERS.SUBJECT]: "alice",
            [AUTH_HEADERS.TYPE]: `utf-8''${encodeURIComponent(CONTROLS_ONLY)}`,
        }),
    compare: (http, local) => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.deepStrictEqual(result.response, { message: "edge-default", subject: "alice" }, `${name} transport must apply the default type`);
        }
        defaultCompare(http, local);
    },
});
