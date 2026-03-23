/**
 * Unit tests for auth-specific error types
 *
 * Tests AuthzDeniedError for correct error properties, ConnectError inheritance,
 * SanitizableError protocol compliance, and server details behavior.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { isSanitizableError } from "@connectum/core";
import type { AuthzDeniedDetails } from "../../src/errors.ts";
import { AuthzDeniedError } from "../../src/errors.ts";

describe("AuthzDeniedError", () => {
    const fullDetails: AuthzDeniedDetails = {
        ruleName: "require-admin",
        requiredRoles: ["admin", "superadmin"],
        requiredScopes: ["users:write", "users:delete"],
    };

    describe("basic properties", () => {
        it('should have name === "AuthzDeniedError"', () => {
            const error = new AuthzDeniedError(fullDetails);
            assert.strictEqual(error.name, "AuthzDeniedError");
        });

        it("should extend ConnectError (has ConnectError in prototype chain)", () => {
            const error = new AuthzDeniedError(fullDetails);
            // Verify Error inheritance
            assert.ok(error instanceof Error);
            // Verify ConnectError prototype in chain (structural check avoids ESM dual-package instanceof issues)
            const proto = Object.getPrototypeOf(Object.getPrototypeOf(error));
            assert.strictEqual(proto.constructor.name, "ConnectError");
            // Verify ConnectError-specific property
            assert.strictEqual(typeof error.code, "number");
        });

        it("should have code === Code.PermissionDenied", () => {
            const error = new AuthzDeniedError(fullDetails);
            assert.strictEqual(error.code, Code.PermissionDenied);
        });

        it('should have clientMessage === "Access denied"', () => {
            const error = new AuthzDeniedError(fullDetails);
            assert.strictEqual(error.clientMessage, "Access denied");
        });

        it("should include rule name in message", () => {
            const error = new AuthzDeniedError(fullDetails);
            assert.match(error.message, /require-admin/);
        });

        it("should include rule name in message for different rule names", () => {
            const error = new AuthzDeniedError({ ruleName: "check-scope-xyz" });
            assert.match(error.message, /check-scope-xyz/);
        });
    });

    describe("serverDetails", () => {
        it("should return ruleName, requiredRoles, and requiredScopes", () => {
            const error = new AuthzDeniedError(fullDetails);
            const details = error.serverDetails;

            assert.deepStrictEqual(details, {
                ruleName: "require-admin",
                requiredRoles: ["admin", "superadmin"],
                requiredScopes: ["users:write", "users:delete"],
            });
        });

        it("should return undefined for roles and scopes when not provided", () => {
            const error = new AuthzDeniedError({ ruleName: "minimal-rule" });
            const details = error.serverDetails;

            assert.strictEqual(details.ruleName, "minimal-rule");
            assert.strictEqual(details.requiredRoles, undefined);
            assert.strictEqual(details.requiredScopes, undefined);
        });

        it("should return empty arrays for roles/scopes when provided as empty", () => {
            const error = new AuthzDeniedError({
                ruleName: "empty-arrays-rule",
                requiredRoles: [],
                requiredScopes: [],
            });
            const details = error.serverDetails;

            assert.strictEqual(details.ruleName, "empty-arrays-rule");
            assert.deepStrictEqual(details.requiredRoles, []);
            assert.deepStrictEqual(details.requiredScopes, []);
        });
    });

    describe("SanitizableError protocol", () => {
        it("should be recognized by isSanitizableError()", () => {
            const error = new AuthzDeniedError(fullDetails);
            assert.strictEqual(isSanitizableError(error), true);
        });

        it("should have clientMessage as string", () => {
            const error = new AuthzDeniedError({ ruleName: "test" });
            assert.strictEqual(typeof error.clientMessage, "string");
        });

        it("should have serverDetails as non-null object", () => {
            const error = new AuthzDeniedError({ ruleName: "test" });
            assert.strictEqual(typeof error.serverDetails, "object");
            assert.notStrictEqual(error.serverDetails, null);
        });
    });

    describe("authzDetails", () => {
        it("should preserve the original details object", () => {
            const details: AuthzDeniedDetails = {
                ruleName: "preserve-test",
                requiredRoles: ["editor"],
                requiredScopes: ["docs:read"],
            };
            const error = new AuthzDeniedError(details);

            assert.strictEqual(error.authzDetails, details);
            assert.strictEqual(error.authzDetails.ruleName, "preserve-test");
            assert.deepStrictEqual(error.authzDetails.requiredRoles, ["editor"]);
            assert.deepStrictEqual(error.authzDetails.requiredScopes, ["docs:read"]);
        });

        it("should preserve details with only ruleName", () => {
            const details: AuthzDeniedDetails = { ruleName: "only-name" };
            const error = new AuthzDeniedError(details);

            assert.strictEqual(error.authzDetails, details);
            assert.strictEqual(error.authzDetails.ruleName, "only-name");
            assert.strictEqual(error.authzDetails.requiredRoles, undefined);
            assert.strictEqual(error.authzDetails.requiredScopes, undefined);
        });
    });
});
