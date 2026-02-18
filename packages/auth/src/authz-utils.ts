/**
 * Shared authorization utilities.
 *
 * Contains functions used by both the declarative rules-based authz interceptor
 * and the proto-based authz interceptor.
 *
 * @module authz-utils
 */

/**
 * Requirements that must be satisfied for authorization.
 *
 * Compatible with both {@link AuthzRule["requires"]} and proto {@link AuthRequirements}.
 */
interface Requirements {
    readonly roles?: ReadonlyArray<string>;
    readonly scopes?: ReadonlyArray<string>;
}

/**
 * Check if the auth context satisfies authorization requirements.
 *
 * - **roles**: "any-of" semantics -- the user must have at least one of the required roles.
 * - **scopes**: "all-of" semantics -- the user must have every required scope.
 *
 * @param context - Auth context with user's roles and scopes
 * @param requires - Requirements to check against
 * @returns `true` if all requirements are satisfied
 */
export function satisfiesRequirements(context: { roles: ReadonlyArray<string>; scopes: ReadonlyArray<string> }, requires: Requirements): boolean {
    // Check roles: user must have at least one of the required roles
    if (requires.roles && requires.roles.length > 0) {
        const hasRole = requires.roles.some((role) => context.roles.includes(role));
        if (!hasRole) {
            return false;
        }
    }

    // Check scopes: user must have ALL required scopes
    if (requires.scopes && requires.scopes.length > 0) {
        const hasAllScopes = requires.scopes.every((scope) => context.scopes.includes(scope));
        if (!hasAllScopes) {
            return false;
        }
    }

    return true;
}
