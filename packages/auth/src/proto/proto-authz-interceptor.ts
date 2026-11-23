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
import { isInternalContext } from "../internal-context.ts";
import { matchesMethodPattern } from "../method-match.ts";
import { assertAuthzPolicy, assertRuleMethods, describeValue } from "../option-validation.ts";
import type { AuthContext, AuthzRule, ProtoAuthzInterceptorOptions, ResourceAuthzLogger } from "../types.ts";
import { AuthzEffect } from "../types.ts";
import type { ResolvedMethodAuth } from "./reader.ts";
import { resolveMethodAuth } from "./reader.ts";
import { createResourceGate } from "./resource-gate.ts";
import { ResourceRuleError } from "./resource-rules.ts";

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
 * 1.  resolveMethodAuth(req.method)  -- read proto options
 * 2.  public = true                  --> skip (allow without authn)
 * 3.  Get auth context               -- lazy: don't throw yet
 * 3b. internal = true:               -- service-to-service (ADR-029)
 *       no context                   --> throw Unauthenticated
 *       no requires                  --> allow when the context was established by
 *                                        createInternalAuthInterceptor, else
 *                                        throw Unauthenticated (untrusted)
 *       has requires                 --> fall through to step 4 (inclusive roles)
 * 4.  requires defined, no context   --> throw Unauthenticated
 * 4b. requires defined, has context  --> satisfiesRequirements? allow : deny
 * 5.  policy = "allow"              --> allow
 * 6.  policy = "deny"               --> deny
 * 7.  Evaluate programmatic rules   -- unconditional rules work without context
 * 8.  Fallback: authorize callback  --> requires auth context
 * 9.  Apply defaultPolicy           --> deny without context = Unauthenticated
 *                                    (a method with resource rules is gated instead of denied)
 * ```
 *
 * Every allowing outcome above (3b, 4b, 5, 7, 8 and 9) of a method that declares
 * `resources` rules passes the resource gate before the handler: an authenticated caller
 * is required, and every rule must be allowed by `resourceAuthorizer`. A denial at steps
 * 4b, 6, 7 or 8 stays a denial and does not reach the gate.
 *
 * IMPORTANT: This interceptor MUST run AFTER an authentication interceptor
 * in the chain (except for methods marked as `public` in proto options
 * or matched by unconditional programmatic rules). For `internal` methods the
 * upstream interceptor is {@link createInternalAuthInterceptor}; the chain order
 * is `errorHandler -> (jwtAuth | internalAuth) -> protoAuthz` — the auth
 * interceptors populate the `AuthContext` that this interceptor consumes.
 *
 * @param options - Proto authorization interceptor options
 * @returns ConnectRPC interceptor
 * @throws {TypeError} When `defaultPolicy` or the `effect` of a rule is not exactly `"allow"` or `"deny"`,
 *   or when the `methods` of a rule hold a pattern other than `"*"`, `"Service/*"` or `"Service/Method"`
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
    const { defaultPolicy = AuthzEffect.DENY, rules = [], authorize, resourceAuthorizer, hideExistence, services, logger = console } = options;

    assertAuthzPolicy("createProtoAuthzInterceptor", defaultPolicy, rules);
    assertRuleMethods("createProtoAuthzInterceptor", rules);
    assertResourceOptions("createProtoAuthzInterceptor", { resourceAuthorizer, hideExistence });

    // A contract error (a mistyped field path in a resource rule) is a startup failure when the services are known.
    for (const service of services ?? []) {
        for (const method of service.methods) {
            resolveMethodAuth(method);
        }
    }

    const gate = createResourceGate({ resourceAuthorizer, hideExistence, logger });

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Step 1: Resolve proto authorization config for this method
        const resolved = resolveForCall(req, logger);

        // Hand the call on once the method-level decision allowed it. A method with resource
        // rules passes the gate first; every allowing outcome below goes through here.
        const proceed = async (authContext: AuthContext | undefined) => {
            if (resolved.resources === undefined || resolved.resources.length === 0) {
                return await next(req);
            }
            return await gate(next, req, resolved.resources, authContext);
        };

        // Step 2: Public methods skip all authn + authz
        if (resolved.public) {
            return await next(req);
        }

        // Step 3: Get auth context (lazy -- don't throw yet, only when actually needed)
        const authContext = getAuthContext();

        // Step 3b: Internal (service-to-service) methods (ADR-029).
        // The internal identity is populated upstream by createInternalAuthInterceptor.
        // Compose inclusively with the existing model: an internal method with no
        // `requires` is reachable by any trusted internal caller; an internal method
        // WITH `requires` falls through to the existing step-4 roles/scopes check
        // against the same AuthContext (one model, no parallel requires_identity).
        if (resolved.internal) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            if (resolved.requires === undefined) {
                // "Any trusted internal caller" means an identity the internal interceptor
                // established. Any other identity (an end-user JWT, gateway headers) proves
                // nothing about an internal caller, and it is what reaches this point when
                // the internal interceptor is missing from the chain or covers no method.
                if (!isInternalContext(authContext)) {
                    throw new ConnectError("Untrusted internal request", Code.Unauthenticated);
                }
                return await proceed(authContext);
            }
            // else: fall through to step 4 requires check (inclusive role composition)
        }

        // Step 4: Check proto requirements (roles/scopes)
        if (resolved.requires !== undefined) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            if (satisfiesRequirements(authContext, resolved.requires)) {
                // Requirements satisfied -- allow
                return await proceed(authContext);
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
            return await proceed(authContext);
        }
        // A deny inherited from the service default is only a default: a declared resource rule
        // replaces it, so the remaining steps and the gate decide. The method's own deny stays final.
        const declaresResources = resolved.resources !== undefined && resolved.resources.length > 0;
        if (resolved.policy === AuthzEffect.DENY && !(resolved.policyInherited === true && declaresResources)) {
            throw new AuthzDeniedError({ ruleName: "proto:policy" });
        }

        // Step 7: Fallback to programmatic rules
        // Rules without `requires` match unconditionally (even without auth context).
        // Rules with `requires` are skipped when no auth context is available.
        if (rules.length > 0) {
            const ruleResult = evaluateRules(rules, authContext, serviceName, methodName);
            if (ruleResult) {
                // Only the exact "allow" lets the call through. The factory refuses every other
                // effect, but the rules array is held by reference: a value put there later must deny.
                if (ruleResult.effect !== AuthzEffect.ALLOW) {
                    const details: AuthzDeniedDetails = {
                        ruleName: ruleResult.ruleName,
                        ...(ruleResult.requiredRoles && { requiredRoles: [...ruleResult.requiredRoles] }),
                        ...(ruleResult.requiredScopes && { requiredScopes: [...ruleResult.requiredScopes] }),
                    };
                    throw new AuthzDeniedError(details);
                }
                return await proceed(authContext);
            }
        }

        // Step 8: Fallback to authorize callback
        if (authorize) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            const allowed = await authorize(authContext, { service: serviceName, method: methodName });
            // Exactly `true` allows. A truthy non-boolean ("false" read from a claim, 1, {}) is a
            // bug in the callback, and authorization fails closed on it.
            if (allowed !== true) {
                throw new ConnectError("Access denied", Code.PermissionDenied);
            }
            return await proceed(authContext);
        }

        // Step 9: No proto config, no rules matched, no callback -- apply default policy.
        // A declared resource rule is itself the requirement, so it replaces the default denial:
        // the gate decides (and demands an authenticated caller) instead.
        if (defaultPolicy !== AuthzEffect.ALLOW && !declaresResources) {
            if (!authContext) {
                throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
            }
            throw new ConnectError("Access denied by default policy", Code.PermissionDenied);
        }

        return await proceed(authContext);
    };
}

/**
 * Resolve the proto authorization of the called method. A resource rule that cannot be used is a
 * mistake in the contract, not in the request: the call ends with `Internal`, and the reason,
 * which names contract fields, stays in the log.
 */
function resolveForCall(req: UnaryRequest | StreamRequest, logger: ResourceAuthzLogger): ResolvedMethodAuth {
    try {
        return resolveMethodAuth(req.method);
    } catch (error) {
        if (error instanceof ResourceRuleError) {
            logger.error(`@connectum/auth: ${req.service.typeName}/${req.method.name} has an unusable resource rule; the client receives Internal`, error);
            throw new ConnectError("Internal error", Code.Internal, undefined, undefined, error);
        }
        throw error;
    }
}

/** Refuse resource options that can never work, at creation. */
function assertResourceOptions(factory: string, options: Pick<ProtoAuthzInterceptorOptions, "resourceAuthorizer" | "hideExistence">): void {
    const { resourceAuthorizer, hideExistence } = options;
    if (resourceAuthorizer !== undefined && typeof resourceAuthorizer?.check !== "function") {
        throw new TypeError(`@connectum/auth: ${factory} resourceAuthorizer must be an object with a check() function; got ${describeValue(resourceAuthorizer)}`);
    }
    if (hideExistence === undefined) {
        return;
    }
    if (typeof hideExistence?.action !== "string" || hideExistence.action === "") {
        throw new TypeError(`@connectum/auth: ${factory} hideExistence.action must be a non-empty string; got ${describeValue(hideExistence?.action)}`);
    }
    for (const [type, action] of Object.entries(hideExistence.byType ?? {})) {
        if (typeof action !== "string" || action === "") {
            throw new TypeError(`@connectum/auth: ${factory} hideExistence.byType["${type}"] must be a non-empty string; got ${describeValue(action)}`);
        }
    }
}
