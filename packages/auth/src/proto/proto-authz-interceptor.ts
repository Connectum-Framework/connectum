/**
 * Proto-based authorization interceptor.
 *
 * Reads authorization configuration from protobuf custom options
 * (connectum.auth.v1) and applies declarative authorization rules
 * defined in .proto files. Falls back to programmatic rules and callbacks.
 *
 * @module proto/proto-authz-interceptor
 */

import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { satisfiesRequirements } from "../authz-utils.ts";
import { getAuthContext } from "../context.ts";
import type { AuthzDeniedDetails } from "../errors.ts";
import { AuthzDeniedError } from "../errors.ts";
import { matchesMethodPattern } from "../method-match.ts";
import type { AuthzRule, ProtoAuthzInterceptorOptions } from "../types.ts";
import { AuthzEffect } from "../types.ts";
import { resolveMethodAuth } from "./reader.ts";

/**
 * Evaluate programmatic authorization rules against auth context for a specific method.
 *
 * Returns the effect of the first matching rule, or undefined if no rule matches.
 *
 * When `context` is null (no auth context available), rules with `requires`
 * are skipped since they cannot be evaluated. Rules without `requires`
 * still match unconditionally — this allows "public" programmatic rules
 * to grant access without authentication.
 *
 * @param rules - Authorization rules to evaluate
 * @param context - Auth context with user's roles and scopes, or undefined if unauthenticated
 * @param serviceName - Fully-qualified service type name
 * @param methodName - RPC method name
 * @returns Matched rule result or undefined
 */
function evaluateRules(
    rules: AuthzRule[],
    context: { roles: ReadonlyArray<string>; scopes: ReadonlyArray<string> } | undefined,
    serviceName: string,
    methodName: string,
): { effect: string; ruleName: string; requiredRoles?: readonly string[]; requiredScopes?: readonly string[] } | undefined {
    for (const rule of rules) {
        const matches = matchesMethodPattern(serviceName, methodName, rule.methods);
        if (!matches) {
            continue;
        }

        // If rule has requirements, check them
        if (rule.requires) {
            // Skip rules with requirements when no auth context is available
            if (!context) {
                continue;
            }
            if (satisfiesRequirements(context, rule.requires)) {
                const result: { effect: string; ruleName: string; requiredRoles?: readonly string[]; requiredScopes?: readonly string[] } = {
                    effect: rule.effect,
                    ruleName: rule.name,
                };
                if (rule.requires.roles) result.requiredRoles = rule.requires.roles;
                if (rule.requires.scopes) result.requiredScopes = rule.requires.scopes;
                return result;
            }
            // Requirements not met -- this rule doesn't match, continue to next
            continue;
        }

        // No requirements -- rule matches unconditionally
        return { effect: rule.effect, ruleName: rule.name };
    }

    return undefined;
}

/**
 * Create a proto-based authorization interceptor.
 *
 * Uses protobuf custom options (connectum.auth.v1) for declarative authorization
 * rules defined in .proto files. When proto options do not resolve the decision,
 * falls back to programmatic rules and an authorize callback.
 *
 * Authorization decision flow:
 * ```
 * 1. resolveMethodAuth(req.method)  -- read proto options
 * 2. public = true                  --> skip (allow without authn)
 * 3. Get auth context               -- lazy: don't throw yet
 * 4. requires defined, no context   --> throw Unauthenticated
 * 4b. requires defined, has context --> satisfiesRequirements? allow : deny
 * 5. policy = "allow"              --> allow
 * 6. policy = "deny"               --> deny
 * 7. Evaluate programmatic rules   -- unconditional rules work without context
 * 8. Fallback: authorize callback  --> requires auth context
 * 9. Apply defaultPolicy           --> deny without context = Unauthenticated
 * ```
 *
 * IMPORTANT: This interceptor MUST run AFTER an authentication interceptor
 * in the chain (except for methods marked as `public` in proto options
 * or matched by unconditional programmatic rules).
 *
 * @param options - Proto authorization interceptor options
 * @returns ConnectRPC interceptor
 *
 * @example Basic usage with proto options only
 * ```typescript
 * import { createProtoAuthzInterceptor } from '@connectum/auth';
 *
 * const authz = createProtoAuthzInterceptor();
 * // Proto options in .proto files control authorization
 * ```
 *
 * @example With fallback programmatic rules
 * ```typescript
 * import { createProtoAuthzInterceptor } from '@connectum/auth';
 *
 * const authz = createProtoAuthzInterceptor({
 *   defaultPolicy: 'deny',
 *   rules: [
 *     { name: 'admin-only', methods: ['admin.v1.AdminService/*'], requires: { roles: ['admin'] }, effect: 'allow' },
 *   ],
 *   authorize: (ctx, req) => ctx.roles.includes('superadmin'),
 * });
 * ```
 */
export function createProtoAuthzInterceptor(options: ProtoAuthzInterceptorOptions = {}): Interceptor {
    const { defaultPolicy = AuthzEffect.DENY, rules = [], authorize } = options;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Step 1: Resolve proto authorization config for this method
        const resolved = resolveMethodAuth(req.method);

        // Step 2: Public methods skip all authn + authz
        if (resolved.public) {
            return await next(req);
        }

        // Step 3: Get auth context (lazy -- don't throw yet, only when actually needed)
        const authContext = getAuthContext();

        // Step 4: Check proto requirements (roles/scopes)
        if (resolved.requires !== undefined) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            if (satisfiesRequirements(authContext, resolved.requires)) {
                // Requirements satisfied -- allow
                return await next(req);
            }
            // Requirements not satisfied -- deny with details
            const details: AuthzDeniedDetails = {
                ruleName: "proto",
                ...(resolved.requires.roles.length > 0 && { requiredRoles: resolved.requires.roles }),
                ...(resolved.requires.scopes.length > 0 && { requiredScopes: resolved.requires.scopes }),
            };
            throw new AuthzDeniedError(details);
        }

        // Step 5-6: Check proto policy
        if (resolved.policy === AuthzEffect.ALLOW) {
            return await next(req);
        }
        if (resolved.policy === AuthzEffect.DENY) {
            throw new AuthzDeniedError({ ruleName: "proto:policy" });
        }

        // Step 7: Fallback to programmatic rules
        // Rules without `requires` match unconditionally (even without auth context).
        // Rules with `requires` are skipped when no auth context is available.
        if (rules.length > 0) {
            const ruleResult = evaluateRules(rules, authContext, serviceName, methodName);
            if (ruleResult) {
                if (ruleResult.effect === AuthzEffect.DENY) {
                    const details: AuthzDeniedDetails = {
                        ruleName: ruleResult.ruleName,
                        ...(ruleResult.requiredRoles && { requiredRoles: [...ruleResult.requiredRoles] }),
                        ...(ruleResult.requiredScopes && { requiredScopes: [...ruleResult.requiredScopes] }),
                    };
                    throw new AuthzDeniedError(details);
                }
                // ALLOW -- continue
                return await next(req);
            }
        }

        // Step 8: Fallback to authorize callback
        if (authorize) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            const allowed = await authorize(authContext, { service: serviceName, method: methodName });
            if (!allowed) {
                throw new ConnectError("Access denied", Code.PermissionDenied);
            }
            return await next(req);
        }

        // Step 9: No proto config, no rules matched, no callback -- apply default policy
        if (defaultPolicy === AuthzEffect.DENY) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            throw new ConnectError("Access denied by default policy", Code.PermissionDenied);
        }

        return await next(req);
    };
}
