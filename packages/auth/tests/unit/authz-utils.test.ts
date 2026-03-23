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

            it("should return true when only scopes are required and user has them", () => {
                const context = { roles: [], scopes: ["read", "write"] };
                const requires = { roles: [], scopes: ["read"] };

                assert.strictEqual(satisfiesRequirements(context, requires), true);
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

            it("should return false when context has empty roles/scopes but requirements are non-empty", () => {
                const context = { roles: [], scopes: [] };
                const requires = { roles: ["admin"], scopes: ["read"] };

                assert.strictEqual(satisfiesRequirements(context, requires), false);
            });
        });
    });
});
