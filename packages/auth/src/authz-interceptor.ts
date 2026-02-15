/**
 * Authorization interceptor
 *
 * Declarative rules-based authorization with RBAC support.
 * Evaluates rules against AuthContext from the auth interceptor.
 *
 * @module authz-interceptor
 */

import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "./context.ts";
import type { AuthzDeniedDetails } from "./errors.ts";
import { AuthzDeniedError } from "./errors.ts";
import { matchesMethodPattern } from "./method-match.ts";
import type { AuthzInterceptorOptions, AuthzRule } from "./types.ts";
import { AuthzEffect } from "./types.ts";

/**
 * Check if the auth context satisfies a rule's requirements.
 */
function satisfiesRequirements(context: { roles: ReadonlyArray<string>; scopes: ReadonlyArray<string> }, requires: NonNullable<AuthzRule["requires"]>): boolean {
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

/**
 * Evaluate authorization rules against auth context for a specific method.
 *
 * Returns the effect of the first matching rule, or undefined if no rule matches.
 */
function evaluateRules(
    rules: AuthzRule[],
    context: { roles: ReadonlyArray<string>; scopes: ReadonlyArray<string> },
    serviceName: string,
    methodName: string,
): { effect: string; ruleName: string; requiredRoles?: readonly string[]; requiredScopes?: readonly string[] } | undefined {
    for (const rule of rules) {
        // Check if any of the rule's method patterns match
        const matches = matchesMethodPattern(serviceName, methodName, rule.methods);
        if (!matches) {
            continue;
        }

        // If rule has requirements, check them
        if (rule.requires) {
            if (satisfiesRequirements(context, rule.requires)) {
                const result: { effect: string; ruleName: string; requiredRoles?: readonly string[]; requiredScopes?: readonly string[] } = {
                    effect: rule.effect,
                    ruleName: rule.name,
                };
                if (rule.requires.roles) result.requiredRoles = rule.requires.roles;
                if (rule.requires.scopes) result.requiredScopes = rule.requires.scopes;
                return result;
            }
            // Requirements not met — this rule doesn't match, continue to next
            continue;
        }

        // No requirements — rule matches unconditionally
        return { effect: rule.effect, ruleName: rule.name };
    }

    return undefined;
}

/**
 * Create an authorization interceptor.
 *
 * Evaluates declarative rules and/or a programmatic callback against
 * the AuthContext established by the authentication interceptor.
 *
 * IMPORTANT: This interceptor MUST run AFTER an authentication interceptor
 * in the chain.
 *
 * @param options - Authorization options
 * @returns ConnectRPC interceptor
 *
 * @example RBAC with declarative rules
 * ```typescript
 * import { createAuthzInterceptor } from '@connectum/auth';
 *
 * const authz = createAuthzInterceptor({
 *   defaultPolicy: 'deny',
 *   rules: [
 *     { name: 'public', methods: ['public.v1.PublicService/*'], effect: 'allow' },
 *     { name: 'admin', methods: ['admin.v1.AdminService/*'], requires: { roles: ['admin'] }, effect: 'allow' },
 *   ],
 * });
 * ```
 */
export function createAuthzInterceptor(options: AuthzInterceptorOptions = {}): Interceptor {
    const { defaultPolicy = AuthzEffect.DENY, rules = [], authorize, skipMethods = [] } = options;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Skip specified methods
        if (matchesMethodPattern(serviceName, methodName, skipMethods)) {
            return await next(req);
        }

        // Get auth context from AsyncLocalStorage
        const authContext = getAuthContext();
        if (!authContext) {
            throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
        }

        // Evaluate declarative rules first
        if (rules.length > 0) {
            const ruleResult = evaluateRules(rules, authContext, serviceName, methodName);
            if (ruleResult) {
                if (ruleResult.effect === AuthzEffect.DENY) {
                    const details: AuthzDeniedDetails = { ruleName: ruleResult.ruleName };
                    if (ruleResult.requiredRoles) (details as { requiredRoles: readonly string[] }).requiredRoles = [...ruleResult.requiredRoles];
                    if (ruleResult.requiredScopes) (details as { requiredScopes: readonly string[] }).requiredScopes = [...ruleResult.requiredScopes];
                    throw new AuthzDeniedError(details);
                }
                // ALLOW — continue
                return await next(req);
            }
        }

        // If no rules matched, try programmatic callback
        if (authorize) {
            const allowed = await authorize(authContext, { service: serviceName, method: methodName });
            if (!allowed) {
                throw new ConnectError("Access denied", Code.PermissionDenied);
            }
            return await next(req);
        }

        // No rules matched, no callback — apply default policy
        if (defaultPolicy === AuthzEffect.DENY) {
            throw new ConnectError("Access denied by default policy", Code.PermissionDenied);
        }

        return await next(req);
    };
}
