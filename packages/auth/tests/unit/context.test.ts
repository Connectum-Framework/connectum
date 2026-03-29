/**
 * Unit tests for auth context storage
 *
 * Tests getAuthContext() and requireAuthContext() behavior
 * with and without AsyncLocalStorage context.
 */

import assert from "node:assert";
import type { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
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
                    assertConnectError(err, Code.Unauthenticated, /Authentication required/);
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

describe("globalThis singleton resilience", () => {
    const STORAGE_KEY = Symbol.for("@connectum/auth/context-storage");
    const META_KEY = Symbol.for("@connectum/auth/context-storage-meta");

    it("should store authContextStorage in globalThis via Symbol.for key", () => {
        const stored = (globalThis as Record<symbol, unknown>)[STORAGE_KEY];
        assert.strictEqual(authContextStorage, stored,
            "authContextStorage should be the same instance as globalThis[STORAGE_KEY]");
    });

    it("should have meta with initUrl", () => {
        const meta = (globalThis as Record<symbol, unknown>)[META_KEY] as { initUrl: string; warned: boolean };
        assert.ok(meta, "meta should exist");
        assert.strictEqual(typeof meta.initUrl, "string");
        assert.strictEqual(typeof meta.warned, "boolean");
    });

    it("should preserve auth context when accessed via globalThis storage", async () => {
        const mockContext: AuthContext = {
            subject: "dual-instance-test",
            roles: ["admin"],
            scopes: ["read"],
            claims: {},
            type: "jwt",
        };

        await authContextStorage.run(mockContext, async () => {
            // Read from globalThis directly (simulates second module evaluation)
            const storageFromGlobal = (globalThis as Record<symbol, unknown>)[STORAGE_KEY] as AsyncLocalStorage<AuthContext>;
            const context = storageFromGlobal.getStore();

            assert.ok(context);
            assert.strictEqual(context.subject, "dual-instance-test");
        });
    });

    it("should detect corrupted globalThis storage via structural check", () => {
        const g = globalThis as Record<symbol, unknown>;
        const original = g[STORAGE_KEY];

        try {
            g[STORAGE_KEY] = "not-a-storage";
            const value = g[STORAGE_KEY];
            const isValid = (
                value != null &&
                typeof (value as Record<string, unknown>).run === "function" &&
                typeof (value as Record<string, unknown>).getStore === "function" &&
                typeof (value as Record<string, unknown>).enterWith === "function"
            );
            assert.strictEqual(isValid, false, "corrupted value should fail structural check");
        } finally {
            g[STORAGE_KEY] = original;
        }
    });
});
