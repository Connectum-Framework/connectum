/**
 * Unit tests for shared authorization utilities
 *
 * Tests satisfiesRequirements() for role (any-of) and scope (all-of)
 * semantics, including edge cases with empty and undefined fields.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { satisfiesRequirements } from "../../src/authz-utils.ts";

describe("authz-utils", () => {
    describe("satisfiesRequirements()", () => {
        describe("positive cases", () => {
            it("should return true when user has one of the required roles (any-of semantics)", () => {
                const context = { roles: ["editor"], scopes: [] };
                const requires = { roles: ["admin", "editor"], scopes: [] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });

            it("should return true when user has all required scopes (all-of semantics)", () => {
                const context = { roles: [], scopes: ["read", "write", "delete"] };
                const requires = { roles: [], scopes: ["read", "write"] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });

            it("should return true when both roles and scopes are satisfied", () => {
                const context = { roles: ["admin"], scopes: ["read", "write"] };
                const requires = { roles: ["admin", "editor"], scopes: ["read", "write"] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });

            it("should return true when requirements have empty roles and scopes arrays", () => {
                const context = { roles: [], scopes: [] };
                const requires = { roles: [], scopes: [] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });

            it("should return true when a required scope is one of several the user holds, regardless of order", () => {
                const context = { roles: [], scopes: ["write", "read"] };

                assert.strictEqual(satisfiesRequirements(context, { roles: [], scopes: ["read"] }), true);
                assert.strictEqual(satisfiesRequirements(context, { roles: [], scopes: ["read", "write"] }), true);
                assert.strictEqual(satisfiesRequirements(context, { roles: [], scopes: ["write", "read"] }), true);
            });

            it("should return true when roles field is undefined in requirements", () => {
                const context = { roles: [], scopes: ["read"] };
                const requires = { scopes: ["read"] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });

            it("should return true when scopes field is undefined in requirements", () => {
                const context = { roles: ["admin"], scopes: [] };
                const requires = { roles: ["admin"] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
            });
        });

        describe("negative cases", () => {
            it("should return false when user has none of the required roles", () => {
                const context = { roles: ["viewer"], scopes: [] };
                const requires = { roles: ["admin", "editor"], scopes: [] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });

            it("should return false when user is missing one required scope (all-of)", () => {
                const context = { roles: [], scopes: ["read"] };
                const requires = { roles: [], scopes: ["read", "write"] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });

            it("should return false when roles are satisfied but scopes are not", () => {
                const context = { roles: ["admin"], scopes: ["read"] };
                const requires = { roles: ["admin"], scopes: ["read", "write"] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });

            it("should return false when scopes are satisfied but roles are not", () => {
                const context = { roles: ["viewer"], scopes: ["read", "write"] };
                const requires = { roles: ["admin"], scopes: ["read"] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });

            it("should compare roles and scopes by exact value, not by prefix, substring or case", () => {
                // A held "administrator" role or "read:all" scope is not the required "admin" / "read".
                assert.strictEqual(satisfiesRequirements({ roles: ["administrator"], scopes: [] }, { roles: ["admin"] }), false);
                assert.strictEqual(satisfiesRequirements({ roles: ["adm"], scopes: [] }, { roles: ["admin"] }), false);
                assert.strictEqual(satisfiesRequirements({ roles: ["Admin"], scopes: [] }, { roles: ["admin"] }), false);
                assert.strictEqual(satisfiesRequirements({ roles: [], scopes: ["read:all"] }, { scopes: ["read"] }), false);
                assert.strictEqual(satisfiesRequirements({ roles: [], scopes: ["rea"] }, { scopes: ["read"] }), false);
                // The same-case exact values do match.
                assert.strictEqual(satisfiesRequirements({ roles: ["admin"], scopes: ["read"] }, { roles: ["admin"], scopes: ["read"] }), true);
            });

            it("should return false when context has empty roles/scopes but requirements are non-empty", () => {
                const context = { roles: [], scopes: [] };
                const requires = { roles: ["admin"], scopes: ["read"] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });
        });
    });
});
