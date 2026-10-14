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

        // The guide states that without an error-handler interceptor the original
        // message carries the rule name; with one, only clientMessage reaches the
        // caller. So the rule name must be in message and must never be in clientMessage.
        for (const ruleName of ["require-admin", "check-scope-xyz", "rule/with spaces"]) {
            it(`should put rule name "${ruleName}" in the server-side message but not in clientMessage`, () => {
                const error = new AuthzDeniedError({ ruleName });
                assert.ok(error.rawMessage.includes(ruleName), `rawMessage should include the rule name: ${error.rawMessage}`);
                assert.ok(!error.clientMessage.includes(ruleName), "clientMessage must not reveal the rule name");
            });
        }

        it("should not expose the required roles or scopes through clientMessage", () => {
            const error = new AuthzDeniedError(fullDetails);
            for (const secret of [...(fullDetails.requiredRoles ?? []), ...(fullDetails.requiredScopes ?? [])]) {
                assert.ok(!error.clientMessage.includes(secret), `clientMessage must not reveal "${secret}"`);
            }
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
    });

    describe("authzDetails", () => {
        it("should preserve the original details object", () => {
            const details: AuthzDeniedDetails = {
                ruleName: "preserve-test",
                requiredRoles: ["editor"],
                requiredScopes: ["docs:read"],
            };
            const error = new AuthzDeniedError(details);

            // Compared by value: whether the error keeps the same object or a copy is not behavior.
            assert.deepStrictEqual(error.authzDetails, {
                ruleName: "preserve-test",
                requiredRoles: ["editor"],
                requiredScopes: ["docs:read"],
            });
            assert.strictEqual(error.ruleName, "preserve-test");
        });

        it("should preserve details with only ruleName", () => {
            const details: AuthzDeniedDetails = { ruleName: "only-name" };
            const error = new AuthzDeniedError(details);

            assert.strictEqual(error.authzDetails.ruleName, "only-name");
            assert.strictEqual(error.ruleName, "only-name");
            assert.strictEqual(error.authzDetails.requiredRoles, undefined);
            assert.strictEqual(error.authzDetails.requiredScopes, undefined);
        });
    });
});
