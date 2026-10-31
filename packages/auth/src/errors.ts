/**
 * Auth-specific error types
 *
 * @module errors
 */

import { Code, ConnectError } from "@connectrpc/connect";
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
    declare readonly clientMessage: string;
    declare readonly ruleName: string;
    declare readonly authzDetails: AuthzDeniedDetails;
    declare readonly serverDetails: Readonly<Record<string, unknown>>;

    /**
     * Connect decides whether a thrown value is a `ConnectError` (and so keeps its code on the
     * wire) by checking that its prototype is exactly `ConnectError.prototype` or that its
     * `name` is "ConnectError". A subclass instance with another `name` fails both checks and
     * reaches the client as `internal`. The constructor therefore builds a plain `ConnectError`
     * and gives it the name and the fields of this class, so the denial keeps `PermissionDenied`
     * with or without an error handler in front.
     */
    constructor(details: AuthzDeniedDetails) {
        super(`Access denied by rule: ${details.ruleName}`, Code.PermissionDenied);
        const error = new ConnectError(`Access denied by rule: ${details.ruleName}`, Code.PermissionDenied);
        Object.defineProperties(error, {
            name: { value: "AuthzDeniedError", writable: true, configurable: true },
            // Reports the class as the constructor (`error.constructor.name`, the head of `util.inspect`).
            constructor: { value: new.target, writable: true, configurable: true },
            clientMessage: { value: "Access denied", enumerable: true },
            ruleName: { value: details.ruleName, enumerable: true },
            authzDetails: { value: details, enumerable: true },
            serverDetails: {
                get: (): Readonly<Record<string, unknown>> => ({
                    ruleName: details.ruleName,
                    requiredRoles: details.requiredRoles,
                    requiredScopes: details.requiredScopes,
                }),
                enumerable: true,
            },
        });
        // biome-ignore lint/correctness/noConstructorReturn: Connect accepts only an object whose prototype is exactly ConnectError.prototype, which a subclass instance cannot be
        return error as AuthzDeniedError;
    }

    /**
     * `ConnectError`'s own check ignores which class it is called on, so it would accept every
     * `ConnectError` as an `AuthzDeniedError`. An instance is recognised by its name and fields.
     */
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof ConnectError && value.name === "AuthzDeniedError" && "authzDetails" in value && "ruleName" in value;
    }
}
