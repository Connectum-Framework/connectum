/**
 * The callbacks of the session interceptor are checked when it is created.
 *
 * A missing `verifySession` or `mapSession`, or an `extractToken` that is not a function, produced an
 * interceptor that answered every request with "Session verification failed" or "Session mapping
 * failed" (or, for `extractToken`, with `internal`), and nothing pointed at the configuration.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { SessionAuthInterceptorOptions } from "../../src/types.ts";

const identity = { subject: "u", roles: [], scopes: [], claims: {}, type: "session" };
const complete = { verifySession: async () => ({}), mapSession: async () => identity };

/** Short readable name of a non-function value, used only in test titles. */
function describeValue(value: unknown): string {
    if (typeof value === "string") {
        return `the string '${value}'`;
    }
    if (typeof value === "object" && value !== null) {
        return "an object";
    }
    return String(value);
}

function create(overrides: Record<string, unknown>) {
    return createSessionAuthInterceptor({ ...complete, ...overrides } as unknown as SessionAuthInterceptorOptions);
}

describe("createSessionAuthInterceptor: required options", () => {
    it("accepts a complete configuration, with and without extractToken", () => {
        create({});
        create({ extractToken: () => "token" });
        create({ extractToken: undefined });
    });

    for (const option of ["verifySession", "mapSession"]) {
        for (const value of [undefined, null, "fn", {}, 5]) {
            it(`refuses ${option} that is not a function (${describeValue(value)})`, () => {
                assert.throws(
                    () => create({ [option]: value }),
                    (err: unknown) => err instanceof TypeError && err.message.startsWith(`@connectum/auth: createSessionAuthInterceptor ${option} must be a function; got `),
                );
            });
        }
    }

    for (const value of [null, "authorization", {}, 5]) {
        it(`refuses an extractToken that is not a function (${describeValue(value)})`, () => {
            assert.throws(
                () => create({ extractToken: value }),
                (err: unknown) => err instanceof TypeError && /createSessionAuthInterceptor extractToken must be a function when set; got /.test(err.message),
            );
        });
    }

    it("refuses a missing options object with the same message", () => {
        assert.throws(() => createSessionAuthInterceptor(undefined as never), /createSessionAuthInterceptor verifySession must be a function/);
    });
});
