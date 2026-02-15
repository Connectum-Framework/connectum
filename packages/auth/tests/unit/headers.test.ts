/**
 * Unit tests for auth header propagation utilities
 *
 * Tests setAuthHeaders() and parseAuthHeaders() for correct
 * serialization/deserialization of AuthContext to/from HTTP headers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

describe("headers", () => {
    describe("setAuthHeaders()", () => {
        it("should set all headers correctly", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                roles: ["admin", "editor"],
                scopes: ["read", "write"],
                claims: { tenant: "acme" },
                type: "jwt",
            };

            setAuthHeaders(headers, context);

            assert.strictEqual(headers.get(AUTH_HEADERS.SUBJECT), "user-1");
            assert.strictEqual(headers.get(AUTH_HEADERS.TYPE), "jwt");
            assert.strictEqual(headers.get(AUTH_HEADERS.ROLES), JSON.stringify(["admin", "editor"]));
            assert.strictEqual(headers.get(AUTH_HEADERS.SCOPES), "read write");
            assert.strictEqual(headers.get(AUTH_HEADERS.CLAIMS), JSON.stringify({ tenant: "acme" }));
        });

        it("should skip empty roles and scopes", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-2",
                roles: [],
                scopes: [],
                claims: {},
                type: "api-key",
            };

            setAuthHeaders(headers, context);

            assert.strictEqual(headers.get(AUTH_HEADERS.SUBJECT), "user-2");
            assert.strictEqual(headers.get(AUTH_HEADERS.TYPE), "api-key");
            assert.strictEqual(headers.get(AUTH_HEADERS.ROLES), null);
            assert.strictEqual(headers.get(AUTH_HEADERS.SCOPES), null);
            assert.strictEqual(headers.get(AUTH_HEADERS.CLAIMS), null);
        });
    });

    describe("parseAuthHeaders()", () => {
        it("should return undefined when subject missing", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.ROLES, '["admin"]');

            const result = parseAuthHeaders(headers);
            assert.strictEqual(result, undefined);
        });

        it("should parse all headers correctly", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.ROLES, '["admin","editor"]');
            headers.set(AUTH_HEADERS.SCOPES, "read write");
            headers.set(AUTH_HEADERS.CLAIMS, '{"tenant":"acme"}');

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject, "user-1");
            assert.strictEqual(result.type, "jwt");
            assert.deepStrictEqual(result.roles, ["admin", "editor"]);
            assert.deepStrictEqual(result.scopes, ["read", "write"]);
            assert.deepStrictEqual(result.claims, { tenant: "acme" });
        });

        it("should handle malformed JSON gracefully", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.ROLES, "not-valid-json");
            headers.set(AUTH_HEADERS.CLAIMS, "{broken");

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject, "user-1");
            assert.deepStrictEqual(result.roles, []);
            assert.deepStrictEqual(result.claims, {});
        });

        it("should default type to 'unknown' when missing", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.type, "unknown");
        });
    });

    describe("round-trip", () => {
        it("should preserve context through setAuthHeaders -> parseAuthHeaders", () => {
            const original: AuthContext = {
                subject: "round-trip-user",
                roles: ["admin", "user"],
                scopes: ["read", "write", "delete"],
                claims: { org: "test-org", level: 5 },
                type: "jwt",
            };

            const headers = new Headers();
            setAuthHeaders(headers, original);
            const restored = parseAuthHeaders(headers);

            assert.ok(restored);
            assert.strictEqual(restored.subject, original.subject);
            assert.strictEqual(restored.type, original.type);
            assert.deepStrictEqual(restored.roles, original.roles);
            assert.deepStrictEqual(restored.scopes, original.scopes);
            assert.deepStrictEqual(restored.claims, original.claims);
        });
    });
});
