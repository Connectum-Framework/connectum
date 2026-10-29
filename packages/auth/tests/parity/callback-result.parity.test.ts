/**
 * A verifier callback result that is not an identity is Unauthenticated on both transports,
 * with header propagation on and off.
 *
 * Before the check, with propagation on the call ended with `internal` (the header write threw
 * a TypeError) and with propagation off the handler ran without any identity. The shipped
 * `createAuthInterceptor()` and `createSessionAuthInterceptor()` are used; the handler reports
 * the subject it sees, so a call that wrongly gets through is visible.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createAuthInterceptor, createSessionAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { createMockAuthContext } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

function routes() {
    return defineService(AuthzService, {
        secureEcho: () => create(EchoResponseSchema, { message: "reached", subject: getAuthContext()?.subject ?? "" }),
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

function describeRejection(err: unknown): NonNullable<ParityScenarioResult["error"]> {
    if (!(err instanceof ConnectError)) {
        return { code: "non-connect", message: String(err) };
    }
    return { code: err.code, message: err.rawMessage, details: [], metadata: {} };
}

async function call(transport: Parameters<typeof createClient>[1]): Promise<ParityScenarioResult> {
    try {
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: { authorization: "Bearer any-token" },
        });
        return { response: { message: res.message, subject: res.subject } };
    } catch (err) {
        return { error: describeRejection(err) };
    }
}

function expectUnauthenticated(message: string) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.ok(result.error, `${name} transport must reject, got ${JSON.stringify(result.response)}`);
            assert.strictEqual(result.error.code, Code.Unauthenticated, `${name} transport must reject with Unauthenticated`);
            assert.strictEqual(result.error.message, message, `${name} transport must deliver the rejection text`);
        }
        defaultCompare(http, local);
    };
}

for (const propagateHeaders of [true, false]) {
    for (const [label, value] of [["null", null], ["{}", {}]] as const) {
        transportParityTest(`parity: verifyCredentials resolving ${label} is Unauthenticated on both transports (propagateHeaders: ${propagateHeaders})`, {
            services: [routes()],
            interceptors: [
                createErrorHandlerInterceptor({ logErrors: false }),
                createAuthInterceptor({ verifyCredentials: async () => value as never, propagateHeaders }),
            ],
            scenario: async ({ transport }) => await call(transport),
            compare: expectUnauthenticated("Authentication failed"),
        });

        transportParityTest(`parity: mapSession resolving ${label} is Unauthenticated on both transports (propagateHeaders: ${propagateHeaders})`, {
            services: [routes()],
            interceptors: [
                createErrorHandlerInterceptor({ logErrors: false }),
                createSessionAuthInterceptor({ verifySession: async () => ({ ok: true }), mapSession: async () => value as never, propagateHeaders }),
            ],
            scenario: async ({ transport }) => await call(transport),
            compare: expectUnauthenticated("Session mapping failed"),
        });
    }
}

transportParityTest("parity: a well-formed identity still reaches the handler on both transports", {
    services: [routes()],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createAuthInterceptor({ verifyCredentials: async () => createMockAuthContext({ subject: "alice" }), propagateHeaders: true }),
    ],
    scenario: async ({ transport }) => await call(transport),
    compare: (http, local) => {
        const expected = { message: "reached", subject: "alice" };
        assert.deepStrictEqual(http.response, expected);
        assert.deepStrictEqual(local.response, expected);
        defaultCompare(http, local);
    },
});
