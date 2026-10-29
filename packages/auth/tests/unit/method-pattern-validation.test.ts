/**
 * Method patterns are checked when an interceptor is created.
 *
 * Only `*`, `Service/*` and `Service/Method` match anything. A partial wildcard such as
 * `Service/Write*` or a wildcard inside the service name was accepted and never matched, so a `deny` rule written that
 * way did nothing and a `skipMethods` entry written that way skipped nothing.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createInternalAuthInterceptor } from "../../src/internal-auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";

const identity = { subject: "u", roles: [], scopes: [], claims: {}, type: "test" };

const unsupported = ["acme.v1.Echo/Un*", "acme.v1.*/*", "acme.*/Unary", "*/Unary", "*/*", "Write*", "acme.v1.Echo", "/acme.v1.Echo/Unary", "acme.v1.Echo/", "/", "", " ", "acme.v1.Echo/Unary ", "a/b/c", "acme.v1.Echo/*/*", "**"];
const supported = ["acme.v1.Echo/Unary", "acme.v1.Echo/*", "grpc.health.v1.Health/*", "Service/Method"];

describe("skipMethods", () => {
    const factories: Array<[string, (skipMethods: string[]) => unknown]> = [
        ["createAuthInterceptor", (skipMethods) => createAuthInterceptor({ verifyCredentials: async () => identity, skipMethods })],
        ["createJwtAuthInterceptor", (skipMethods) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, skipMethods })],
        ["createSessionAuthInterceptor", (skipMethods) => createSessionAuthInterceptor({ verifySession: async () => ({}), mapSession: async () => identity, skipMethods })],
        ["createGatewayAuthInterceptor", (skipMethods) => createGatewayAuthInterceptor({ headerMapping: { subject: "x-user" }, trustSource: { header: "x-gateway", expectedValues: ["secret"] }, skipMethods })],
        ["createAuthzInterceptor", (skipMethods) => createAuthzInterceptor({ defaultPolicy: "deny", skipMethods })],
    ];

    for (const [name, create] of factories) {
        describe(name, () => {
            for (const pattern of unsupported.filter((p) => p !== "**")) {
                it(`refuses ${JSON.stringify(pattern)} and names the option and the supported forms`, () => {
                    assert.throws(
                        () => create([pattern]),
                        (err: unknown) => {
                            assert.ok(err instanceof TypeError);
                            assert.match(err.message, /skipMethods contains the unsupported method pattern/);
                            assert.ok(err.message.includes(JSON.stringify(pattern)), err.message);
                            assert.match(err.message, /"\*", "Service\/\*" or "Service\/Method"/);
                            return true;
                        },
                    );
                });
            }

            it("refuses an unsupported pattern next to supported ones", () => {
                assert.throws(() => create(["acme.v1.Echo/Unary", "acme.v1.*/*"]), /unsupported method pattern "acme\.v1\.\*\/\*"/);
            });

            it("accepts the supported forms and an empty list", () => {
                create(supported);
                create([]);
            });
        });
    }

    it("still reports the catch-all with its own message", () => {
        assert.throws(() => createAuthzInterceptor({ skipMethods: ["*"] }), /must not contain the catch-all pattern "\*"/);
    });
});

describe("rule methods", () => {
    for (const [name, factory] of [
        ["createAuthzInterceptor", createAuthzInterceptor],
        ["createProtoAuthzInterceptor", createProtoAuthzInterceptor],
    ] as const) {
        describe(name, () => {
            for (const pattern of unsupported) {
                it(`refuses a deny rule on ${JSON.stringify(pattern)} and names the rule`, () => {
                    assert.throws(
                        () => factory({ defaultPolicy: "allow", rules: [{ name: "keep-out", methods: ["acme.v1.Echo/Unary", pattern], effect: "deny" }] }),
                        (err: unknown) => {
                            assert.ok(err instanceof TypeError);
                            assert.match(err.message, /rules\[0\]\.methods \(rule "keep-out"\) contains the unsupported method pattern/);
                            return true;
                        },
                    );
                });
            }

            it("accepts '*', Service/* and an exact method in a rule", () => {
                factory({ defaultPolicy: "deny", rules: [{ name: "all", methods: ["*"], effect: "allow" }, { name: "svc", methods: ["acme.v1.Echo/*", "acme.v1.Echo/Unary"], effect: "deny" }] });
            });

            it("refuses a rule whose methods is not an array of strings", () => {
                for (const methods of [undefined, "acme.v1.Echo/Unary", 5, null]) {
                    assert.throws(() => factory({ rules: [{ name: "bad", methods: methods as never, effect: "allow" }] }), /rules\[0\]\.methods \(rule "bad"\) must be an array of method patterns/);
                }
            });
        });
    }
});

describe("internalMethods", () => {
    const trustSource = () => null;

    for (const pattern of unsupported) {
        it(`createInternalAuthInterceptor refuses ${JSON.stringify(pattern)}`, () => {
            assert.throws(
                () => createInternalAuthInterceptor({ internalMethods: [pattern], trustSource }),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /createInternalAuthInterceptor internalMethods contains the unsupported method pattern/);
                    return true;
                },
            );
        });
    }

    it("accepts '*', Service/*, an exact method and an empty list", () => {
        createInternalAuthInterceptor({ internalMethods: ["*"], trustSource });
        createInternalAuthInterceptor({ internalMethods: ["acme.v1.Echo/*", "acme.v1.Echo/Unary"], trustSource });
        createInternalAuthInterceptor({ internalMethods: [], trustSource });
    });
});
