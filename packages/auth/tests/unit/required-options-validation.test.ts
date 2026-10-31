/**
 * Options an interceptor cannot work without are checked when it is created.
 *
 * Before, a gateway interceptor with `expectedValues: [process.env.GATEWAY_SECRET]` (variable
 * unset), a missing `trustSource` or an empty trust header name was created without complaint
 * and then failed every request with `internal` and no message, or threw a bare `TypeError` at
 * creation. The error now names the factory and the option, and never echoes a secret.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createInternalAuthInterceptor, sharedSecretTrust } from "../../src/internal-auth-interceptor.ts";
import type { GatewayAuthInterceptorOptions } from "../../src/types.ts";

const SECRET = "very-secret-gateway-value";

function gateway(overrides: Record<string, unknown>) {
    return createGatewayAuthInterceptor({ headerMapping: { subject: "x-user-id" }, trustSource: { header: "x-gateway-secret", expectedValues: [SECRET] }, ...overrides } as unknown as GatewayAuthInterceptorOptions);
}

describe("createGatewayAuthInterceptor: required options", () => {
    it("accepts a complete configuration", () => {
        gateway({});
    });

    for (const [label, expectedValues] of [
        ["an unset environment variable", [undefined]],
        ["an empty string", [""]],
        ["a number", [123]],
        ["a valid value next to an empty one", [SECRET, ""]],
        ["null", [null]],
    ] as const) {
        it(`refuses expectedValues holding ${label}, naming the entry`, () => {
            assert.throws(
                () => gateway({ trustSource: { header: "x-gateway-secret", expectedValues } }),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /createGatewayAuthInterceptor trustSource\.expectedValues\[\d\] must be a non-empty string/);
                    assert.ok(!err.message.includes(SECRET), "the message must not echo a secret");
                    return true;
                },
            );
        });
    }

    for (const expectedValues of [undefined, SECRET, null, 5, {}]) {
        it(`refuses expectedValues that is not an array (${String(expectedValues)})`, () => {
            assert.throws(
                () => gateway({ trustSource: { header: "x-gateway-secret", expectedValues } }),
                (err: unknown) => err instanceof TypeError && /trustSource\.expectedValues must be an array of non-empty strings/.test(err.message) && !err.message.includes(SECRET),
            );
        });
    }

    for (const header of ["", undefined, null, 5, "   "]) {
        it(`refuses trustSource.header ${JSON.stringify(header)}`, () => {
            assert.throws(
                () => gateway({ trustSource: { header, expectedValues: [SECRET] } }),
                (err: unknown) => err instanceof TypeError && /trustSource\.header must be a valid HTTP header name/.test(err.message),
            );
        });
    }

    for (const trustSource of [undefined, null, "x-gateway-secret", 5, []]) {
        it(`refuses a missing or malformed trustSource (${JSON.stringify(trustSource)})`, () => {
            assert.throws(
                () => gateway({ trustSource }),
                (err: unknown) => err instanceof TypeError && /createGatewayAuthInterceptor trustSource must be an object with header and expectedValues/.test(err.message),
            );
        });
    }

    for (const headerMapping of [undefined, null, "x-user-id", 5]) {
        it(`refuses a missing or malformed headerMapping (${JSON.stringify(headerMapping)})`, () => {
            assert.throws(
                () => gateway({ headerMapping }),
                (err: unknown) => err instanceof TypeError && /createGatewayAuthInterceptor headerMapping must be an object/.test(err.message),
            );
        });
    }

    it("keeps the existing messages for an empty expectedValues list and a missing subject mapping", () => {
        assert.throws(() => gateway({ trustSource: { header: "x-gateway-secret", expectedValues: [] } }), /requires non-empty trustSource\.expectedValues/);
        assert.throws(() => gateway({ headerMapping: {} }), /requires headerMapping\.subject/);
    });
});

describe("createInternalAuthInterceptor: required options", () => {
    const trustSource = sharedSecretTrust({ secret: "s" });

    for (const internalMethods of [undefined, null, "acme.v1.Echo/Sync", {}]) {
        it(`refuses internalMethods that is not an array (${JSON.stringify(internalMethods)})`, () => {
            assert.throws(
                () => createInternalAuthInterceptor({ trustSource, internalMethods: internalMethods as never }),
                (err: unknown) => err instanceof TypeError && /createInternalAuthInterceptor internalMethods must be an array of method patterns/.test(err.message),
            );
        });
    }

    it("keeps refusing a trustSource that is not a function", () => {
        assert.throws(() => createInternalAuthInterceptor({ internalMethods: [], trustSource: undefined as never }), /requires a trustSource function/);
    });
});

describe("createAuthInterceptor: required options", () => {
    for (const verifyCredentials of [undefined, null, "verify", {}]) {
        it(`refuses verifyCredentials that is not a function (${JSON.stringify(verifyCredentials)})`, () => {
            assert.throws(
                () => createAuthInterceptor({ verifyCredentials } as never),
                (err: unknown) => err instanceof TypeError && /createAuthInterceptor verifyCredentials must be a function/.test(err.message),
            );
        });
    }

    for (const extractCredentials of [null, "authorization", {}]) {
        it(`refuses an extractCredentials that is not a function (${JSON.stringify(extractCredentials)})`, () => {
            assert.throws(
                () => createAuthInterceptor({ verifyCredentials: async () => ({ subject: "u", roles: [], scopes: [], claims: {}, type: "t" }), extractCredentials } as never),
                (err: unknown) => err instanceof TypeError && /createAuthInterceptor extractCredentials must be a function/.test(err.message),
            );
        });
    }

    it("accepts the default extractCredentials", () => {
        createAuthInterceptor({ verifyCredentials: async () => ({ subject: "u", roles: [], scopes: [], claims: {}, type: "t" }) });
    });
});
