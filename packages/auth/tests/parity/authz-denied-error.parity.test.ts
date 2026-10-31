/**
 * A rule denial reaches the client as PermissionDenied even without an error handler, on a real
 * server and a real client.
 *
 * `AuthzDeniedError` carried a `name` other than "ConnectError", which Connect's own check
 * (`instanceof ConnectError`, used by the protocol handler) does not accept, so the denial was
 * turned into `internal`. A denial from the default policy, a plain ConnectError, was never
 * affected, and the error handler hid the problem when it was in the chain.
 */

import assert from "node:assert";
import { Code, ConnectError } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { AuthzDeniedError } from "../../src/errors.ts";
import { createAuthInterceptor, createAuthzInterceptor, createProtoAuthzInterceptor } from "../../src/index.ts";
import type { AuthzInterceptorOptions } from "../../src/types.ts";
import { callEcho, echoRoutes, makeEchoService } from "../helpers/echo-service.ts";

const Echo = makeEchoService([{ name: "Unary", auth: { requires: { roles: ["admin"] } } }]);
const signedIn = { authorization: "Bearer any" };
const authenticate = () => createAuthInterceptor({ verifyCredentials: async () => ({ subject: "alice", roles: [], scopes: [], claims: {}, type: "test" }) });
const rules: AuthzInterceptorOptions = { defaultPolicy: "allow", rules: [{ name: "block-all", methods: ["*"], effect: "deny" }] };

for (const [label, chain] of [
    ["createAuthzInterceptor rule", () => [authenticate(), createAuthzInterceptor(rules)]],
    ["createProtoAuthzInterceptor rule", () => [authenticate(), createProtoAuthzInterceptor({ defaultPolicy: "allow", rules: [{ name: "block-all", methods: ["*"], effect: "deny" }] })]],
    ["proto requires", () => [authenticate(), createProtoAuthzInterceptor()]],
] as const) {
    transportParityTest(`parity: ${label} denial is PermissionDenied without an error handler`, {
        services: [echoRoutes(Echo)],
        interceptors: chain() as never,
        scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
        compare: (http, local) => {
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                assert.strictEqual(result.error?.code, Code.PermissionDenied, name);
                assert.match(String(result.error?.message), /^Access denied by rule: /, name);
            }
            defaultCompare(http, local);
        },
    });
}

transportParityTest("parity: with the error handler the client still sees only Access denied", {
    services: [echoRoutes(Echo)],
    interceptors: [createErrorHandlerInterceptor({ logErrors: false }), authenticate(), createAuthzInterceptor(rules)],
    scenario: async ({ transport }) => ({ ...(await callEcho(Echo, transport, { headers: signedIn })) }),
    compare: (http, local) => {
        const expected = { code: Code.PermissionDenied, message: "Access denied" };
        assert.deepStrictEqual(http.error, expected, "HTTP");
        assert.deepStrictEqual(local.error, expected, "local");
        defaultCompare(http, local);
    },
});

import { test } from "node:test";

test("AuthzDeniedError is a ConnectError for Connect and an AuthzDeniedError for callers, and a plain ConnectError is not", () => {
    const denied = new AuthzDeniedError({ ruleName: "r" });
    assert.ok(denied instanceof ConnectError, "Connect's own check must accept it");
    assert.ok(denied instanceof AuthzDeniedError);
    assert.ok(denied instanceof Error);
    assert.strictEqual(denied.name, "AuthzDeniedError");
    assert.ok(!(new ConnectError("x", Code.PermissionDenied) instanceof AuthzDeniedError), "a plain ConnectError must not pass as an AuthzDeniedError");
    assert.ok(!(new Error("x") instanceof AuthzDeniedError));
});
