/**
 * The `authorize` callback allows a call only when it resolves to exactly `true`.
 *
 * It is typed to return a boolean, but plain JavaScript and `any`-typed claims reach it
 * with other values: `(ctx) => ctx.claims.isAdmin` returns the string "false" when the
 * claim is a string. A truthy non-boolean used to allow the call. Authorization has to
 * fail closed, so every other result denies.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { createFakeMethod, createFakeService, createProtoMockRequest } from "../helpers/proto-test-helpers.ts";

const identity: AuthContext = { subject: "alice", roles: [], scopes: [], claims: { isAdmin: "false" }, type: "test" };

/** Results other than `true`. The first five are the ones the report showed being allowed. */
const notTrue: Array<[string, unknown]> = [
    ['the string "false"', "false"],
    ['the string "no"', "no"],
    ["the number 1", 1],
    ["an empty object", {}],
    ["an empty array", []],
    ['the string "true"', "true"],
    ["the number 0", 0],
    ["NaN", Number.NaN],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["a function", () => true],
    ["a Boolean object", new Boolean(true)],
];

type Run = (authorize: () => unknown) => Promise<{ allowed: boolean; error?: unknown }>;

const runAuthz: Run = async (authorize) => {
    const next = createMockNext();
    const handler = createAuthzInterceptor({ defaultPolicy: "allow", authorize: authorize as never })(next);
    try {
        await authContextStorage.run(identity, () => handler(createMockRequest({ service: "t.v1.S", method: "M" })));
        return { allowed: next.mock.calls.length === 1 };
    } catch (error) {
        assert.strictEqual(next.mock.calls.length, 0, "a denied call must not reach the handler");
        return { allowed: false, error };
    }
};

const runProtoAuthz: Run = async (authorize) => {
    const service = createFakeService();
    const method = createFakeMethod(service, "M");
    const next = createMockNext();
    const handler = createProtoAuthzInterceptor({ defaultPolicy: "allow", authorize: authorize as never })(next);
    try {
        await authContextStorage.run(identity, () => handler(createProtoMockRequest(service, method)));
        return { allowed: next.mock.calls.length === 1 };
    } catch (error) {
        assert.strictEqual(next.mock.calls.length, 0, "a denied call must not reach the handler");
        return { allowed: false, error };
    }
};

for (const [name, run] of [
    ["createAuthzInterceptor", runAuthz],
    ["createProtoAuthzInterceptor", runProtoAuthz],
] as const) {
    describe(`${name}: authorize result`, () => {
        for (const [label, value] of notTrue) {
            it(`denies when the callback returns ${label}`, async () => {
                const result = await run(() => value);
                assert.strictEqual(result.allowed, false);
                assertConnectError(result.error, Code.PermissionDenied, "Access denied");
            });

            it(`denies when the callback resolves to ${label}`, async () => {
                const result = await run(async () => value);
                assert.strictEqual(result.allowed, false);
                assertConnectError(result.error, Code.PermissionDenied, "Access denied");
            });
        }

        it("denies when a claim read by the callback is the string \"false\"", async () => {
            const result = await run(() => (identity.claims as { isAdmin: unknown }).isAdmin);
            assert.strictEqual(result.allowed, false);
        });

        it("allows when the callback returns true", async () => {
            assert.strictEqual((await run(() => true)).allowed, true);
        });

        it("allows when the callback resolves to true", async () => {
            assert.strictEqual((await run(async () => true)).allowed, true);
        });

        it("calls the callback once per request", async () => {
            const authorize = mock.fn(() => true);
            await run(authorize);
            assert.strictEqual(authorize.mock.calls.length, 1);
        });
    });
}
