/**
 * Unit tests for auth context storage
 *
 * Tests getAuthContext() and requireAuthContext() behavior
 * with and without AsyncLocalStorage context.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { authContextStorage, getAuthContext, requireAuthContext } from "../../src/context.ts";
import type { AuthContext } from "../../src/types.ts";

describe("context", () => {
    describe("getAuthContext()", () => {
        it("should return undefined outside storage", () => {
            const result = getAuthContext();
            assert.strictEqual(result, undefined);
        });

        it("should return context inside storage.run()", () => {
            const mockContext: AuthContext = {
                subject: "user-1",
                roles: ["admin"],
                scopes: ["read"],
                claims: {},
                type: "test",
            };

            authContextStorage.run(mockContext, () => {
                const result = getAuthContext();
                assert.ok(result);
                assert.strictEqual(result.subject, "user-1");
                assert.deepStrictEqual(result.roles, ["admin"]);
                assert.deepStrictEqual(result.scopes, ["read"]);
                assert.strictEqual(result.type, "test");
            });
        });
    });

    describe("requireAuthContext()", () => {
        it("should throw ConnectError(Unauthenticated) outside storage", () => {
            assert.throws(
                () => requireAuthContext(),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.strictEqual(err.message, "[unauthenticated] Authentication required");
                    return true;
                },
            );
        });

        it("should return context inside storage.run()", () => {
            const mockContext: AuthContext = {
                subject: "user-42",
                roles: ["viewer"],
                scopes: ["read"],
                claims: { foo: "bar" },
                type: "jwt",
            };

            authContextStorage.run(mockContext, () => {
                const result = requireAuthContext();
                assert.strictEqual(result.subject, "user-42");
                assert.deepStrictEqual(result.roles, ["viewer"]);
                assert.deepStrictEqual(result.claims, { foo: "bar" });
                assert.strictEqual(result.type, "jwt");
            });
        });
    });
});
