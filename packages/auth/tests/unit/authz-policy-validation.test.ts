/**
 * Authorization options are checked when the interceptor is created.
 *
 * A policy or rule effect that is not exactly "allow" or "deny" used to be read as
 * "allow", so a typo in a configuration file opened every method no rule matched.
 * These tests pin both halves: the factory refuses the value, and an interceptor
 * whose rules were changed after creation still denies instead of allowing.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext, AuthzRule } from "../../src/types.ts";
import { createFakeMethod, createFakeService, createProtoMockRequest } from "../helpers/proto-test-helpers.ts";

const identity: AuthContext = { subject: "alice", roles: [], scopes: [], claims: {}, type: "test" };

const factories = [
    ["createAuthzInterceptor", createAuthzInterceptor],
    ["createProtoAuthzInterceptor", createProtoAuthzInterceptor],
] as const;

// Every one of these used to behave as "allow". `null` and "" included.
const notAPolicy: unknown[] = ["Deny", "DENY", "Allow", "dney", "block", "", " deny", null, 0, 1, true, false, {}, ["deny"]];

describe("policy and effect validation", () => {
    for (const [name, factory] of factories) {
        describe(name, () => {
            for (const value of notAPolicy) {
                it(`refuses defaultPolicy ${JSON.stringify(value)}`, () => {
                    assert.throws(
                        () => factory({ defaultPolicy: value as never }),
                        (err: unknown) => {
                            assert.ok(err instanceof TypeError, "a configuration error is a TypeError");
                            assert.match(err.message, new RegExp(`${name} defaultPolicy must be "allow" or "deny"`));
                            return true;
                        },
                    );
                });

                it(`refuses rule effect ${JSON.stringify(value)} and names the rule`, () => {
                    const rules = [{ name: "second-rule", methods: ["*"], effect: value }] as unknown as AuthzRule[];
                    assert.throws(
                        () => factory({ defaultPolicy: "deny", rules }),
                        (err: unknown) => {
                            assert.ok(err instanceof TypeError);
                            assert.match(err.message, /rules\[0\]\.effect/);
                            assert.match(err.message, /second-rule/);
                            assert.match(err.message, /"allow" or "deny"/);
                            return true;
                        },
                    );
                });
            }

            it("accepts the two valid values and an omitted defaultPolicy", () => {
                factory({ defaultPolicy: "allow" });
                factory({ defaultPolicy: "deny" });
                factory({});
                factory();
                factory({ rules: [{ name: "a", methods: ["*"], effect: "allow" }, { name: "d", methods: ["*"], effect: "deny" }] });
            });
        });
    }

    it("createAuthzInterceptor denies when defaultPolicy is omitted", async () => {
        const handler = createAuthzInterceptor()(createMockNext());
        await assert.rejects(
            () => authContextStorage.run(identity, () => handler(createMockRequest({ service: "t.v1.S", method: "M" }))),
            (err: unknown) => {
                assertConnectError(err, Code.PermissionDenied);
                return true;
            },
        );
    });

    it("createProtoAuthzInterceptor denies when defaultPolicy is omitted", async () => {
        const service = createFakeService();
        const method = createFakeMethod(service, "M");
        const next = createMockNext();
        const handler = createProtoAuthzInterceptor()(next);
        await assert.rejects(
            () => authContextStorage.run(identity, () => handler(createProtoMockRequest(service, method))),
            (err: unknown) => {
                assertConnectError(err, Code.PermissionDenied);
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 0);
    });

    // The rules array is held by reference, so code that edits it after creation can put a value
    // in it that the factory never saw. Anything other than "allow" must still deny.
    describe("a rule changed after creation", () => {
        it("createAuthzInterceptor: an unknown effect denies", async () => {
            const rules: AuthzRule[] = [{ name: "later", methods: ["*"], effect: "allow" }];
            const next = createMockNext();
            const handler = createAuthzInterceptor({ defaultPolicy: "allow", rules })(next);
            (rules[0] as { effect: string }).effect = "DENY";
            await assert.rejects(
                () => authContextStorage.run(identity, () => handler(createMockRequest({ service: "t.v1.S", method: "M" }))),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.name, "AuthzDeniedError");
                    assert.strictEqual((err as { code?: unknown }).code, Code.PermissionDenied);
                    assert.strictEqual((err as { ruleName?: unknown }).ruleName, "later");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("createProtoAuthzInterceptor: an unknown effect denies", async () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "M");
            const rules: AuthzRule[] = [{ name: "later", methods: ["*"], effect: "allow" }];
            const next = createMockNext();
            const handler = createProtoAuthzInterceptor({ defaultPolicy: "allow", rules })(next);
            (rules[0] as { effect: string }).effect = "block";
            await assert.rejects(
                () => authContextStorage.run(identity, () => handler(createProtoMockRequest(service, method))),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.name, "AuthzDeniedError");
                    assert.strictEqual((err as { code?: unknown }).code, Code.PermissionDenied);
                    assert.strictEqual((err as { ruleName?: unknown }).ruleName, "later");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });
    });
});
