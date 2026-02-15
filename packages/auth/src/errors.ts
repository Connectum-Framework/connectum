/**
 * Auth-specific error types
 *
 * @module errors
 */

import { Code, ConnectError } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: workspace package import
import type { SanitizableError } from "@connectum/core";

/**
 * Details for authorization denied errors.
 */
export interface AuthzDeniedDetails {
    readonly ruleName: string;
    readonly requiredRoles?: readonly string[];
    readonly requiredScopes?: readonly string[];
}

/**
 * Authorization denied error.
 *
 * Carries server-side details (rule name, required roles/scopes) while
 * exposing only "Access denied" to the client via SanitizableError protocol.
 */
export class AuthzDeniedError extends ConnectError implements SanitizableError {
    readonly clientMessage = "Access denied";
    readonly ruleName: string;
    readonly authzDetails: AuthzDeniedDetails;

    get serverDetails(): Readonly<Record<string, unknown>> {
        return {
            ruleName: this.authzDetails.ruleName,
            requiredRoles: this.authzDetails.requiredRoles,
            requiredScopes: this.authzDetails.requiredScopes,
        };
    }

    constructor(details: AuthzDeniedDetails) {
        super(`Access denied by rule: ${details.ruleName}`, Code.PermissionDenied);
        this.name = "AuthzDeniedError";
        this.ruleName = details.ruleName;
        this.authzDetails = details;
    }
}
