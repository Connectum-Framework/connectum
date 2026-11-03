/**
 * `propagatedClaims` of the JWT interceptor.
 *
 * `createJwtAuthInterceptor` is a wrapper around `createAuthInterceptor` and used to drop the
 * option silently, so with `propagateHeaders` the whole token landed in `x-auth-claims`. The
 * option is also checked when an interceptor is created: a string used to be searched as text
 * (`"org_id".includes("id")`), so a mistaken value widened what was sent instead of failing.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";

const REQ = { service: "test.Service", method: "Method" } as const;

/** Run one authenticated call and return the `x-auth-claims` header the next hop would read. */
async function propagatedHeader(options: Partial<JwtAuthInterceptorOptions>): Promise<string | null> {
    const token = await createTestJwt({ sub: "user-1", email: "a@example.com", phone: "+10000000", org_id: "o1" });
    const req = createMockRequest(REQ);
    req.header.set("authorization", `Bearer ${token}`);
    await createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagateHeaders: true, ...options })(createMockNext())(req);
    return req.header.get("x-auth-claims");
}

/** Claims of the header without the per-token timestamps. */
function claimsOf(header: string | null): Record<string, unknown> | null {
    if (header === null) return null;
    const { exp: _exp, iat: _iat, ...rest } = JSON.parse(header) as Record<string, unknown>;
    return rest;
}

describe("createJwtAuthInterceptor: propagatedClaims", () => {
    it("writes only the listed claims to x-auth-claims", async () => {
        assert.deepStrictEqual(claimsOf(await propagatedHeader({ propagatedClaims: ["org_id"] })), { org_id: "o1" });
        assert.deepStrictEqual(claimsOf(await propagatedHeader({ propagatedClaims: ["org_id", "email"] })), { email: "a@example.com", org_id: "o1" });
    });

    it("writes every claim when the option is not set", async () => {
        assert.deepStrictEqual(claimsOf(await propagatedHeader({})), { sub: "user-1", email: "a@example.com", phone: "+10000000", org_id: "o1" });
    });

    it("writes no claims header for an empty list or a list that names no claim of the token", async () => {
        assert.strictEqual(await propagatedHeader({ propagatedClaims: [] }), null);
        assert.strictEqual(await propagatedHeader({ propagatedClaims: ["absent"] }), null);
    });

    it("leaves the identity itself untouched: the filter only shapes the header", async () => {
        const token = await createTestJwt({ sub: "user-1", email: "a@example.com", org_id: "o1" });
        const req = createMockRequest(REQ);
        req.header.set("authorization", `Bearer ${token}`);
        await createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagateHeaders: true, propagatedClaims: ["org_id"] })(createMockNext())(req);
        assert.strictEqual(req.header.get("x-auth-subject"), "user-1");
    });

    const refused: Array<[string, unknown]> = [
        ["a string", "org_id"],
        ["an empty string", ""],
        ["null", null],
        ["an object", { org_id: true }],
        ["a number", 1],
        ["an array with a non-string entry", ["org_id", 1]],
        ["an array with a null entry", [null]],
        ["an array with an empty string", ["org_id", ""]],
    ];

    for (const [label, value] of refused) {
        it(`refuses ${label} when the interceptor is created`, () => {
            assert.throws(
                () => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagatedClaims: value as never }),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /createJwtAuthInterceptor propagatedClaims must be an array of non-empty claim names/);
                    return true;
                },
            );
        });
    }

    it("accepts an omitted option and an explicit undefined", () => {
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET });
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagatedClaims: undefined });
    });

    it("applies the same check to the generic and the session interceptors it shares the option with", () => {
        for (const [factory, create] of [
            ["createAuthInterceptor", (value: unknown) => createAuthInterceptor({ verifyCredentials: async () => ({}) as never, propagatedClaims: value as never })],
            [
                "createSessionAuthInterceptor",
                (value: unknown) => createSessionAuthInterceptor({ verifySession: async () => ({}), mapSession: () => ({}) as never, propagatedClaims: value as never }),
            ],
        ] as const) {
            assert.throws(
                () => create("org_id"),
                (err: unknown) => err instanceof TypeError && err.message.includes(`${factory} propagatedClaims must be an array of non-empty claim names`),
                factory,
            );
            create(["org_id"]);
            create(undefined);
        }
    });
});
