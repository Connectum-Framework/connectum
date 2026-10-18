/**
 * Proto option reader utilities.
 *
 * Reads authorization configuration from protobuf custom options
 * defined in connectum/auth/v1/options.proto. Merges service-level
 * defaults with method-level overrides and caches the result.
 *
 * @module proto/reader
 */

import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { getOption, hasOption, isFieldSet } from "@bufbuild/protobuf";
import { MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";

/**
 * Resolved authorization configuration for a single RPC method.
 *
 * Result of merging service-level defaults with method-level overrides.
 */
export interface ResolvedMethodAuth {
    /** Whether the method is public (skip authn + authz). */
    readonly public: boolean;
    /**
     * Whether the method is internal (service-to-service): skip end-user (JWT)
     * authentication, but require an internal trust marker established by
     * {@link createInternalAuthInterceptor}. Distinct from `public`. See ADR-029.
     */
    readonly internal: boolean;
    /** Authorization policy: "allow", "deny", or undefined (use interceptor default). */
    readonly policy: "allow" | "deny" | undefined;
    /**
     * Required roles and scopes, or undefined if none specified.
     *
     * An empty `roles` or `scopes` list places no restriction on that dimension;
     * `requires {}` (both empty) admits any authenticated caller.
     */
    readonly requires:
        | {
              readonly roles: readonly string[];
              readonly scopes: readonly string[];
          }
        | undefined;
}

/** Cache for resolved method auth to avoid repeated proto reads. */
const resolvedCache = new WeakMap<DescMethod, ResolvedMethodAuth>();

/**
 * Default resolved auth when no proto options are set.
 */
const DEFAULT_RESOLVED: ResolvedMethodAuth = {
    public: false,
    internal: false,
    policy: undefined,
    requires: undefined,
};

/**
 * Resolve the effective authorization configuration for an RPC method.
 *
 * Merges service-level defaults (`service_auth`) with method-level overrides
 * (`method_auth`). Method-level settings take priority over service-level ones.
 *
 * Results are cached in a `WeakMap` keyed by `DescMethod` (singleton per method,
 * so 100% cache hit after the first call for each method).
 *
 * Priority (method overrides service):
 * ```
 * method.public       -> service.public           -> false
 * method.internal     -> service.internal         -> false
 * method.requires     -> service.default_requires -> undefined
 * method.policy       -> service.default_policy    -> undefined
 * ```
 *
 * @param method - The protobuf method descriptor
 * @returns Resolved authorization configuration
 * @throws {Error} When the effective `policy` / `default_policy` is neither empty, `"allow"` nor `"deny"`,
 *   or when the method resolves to both `public` and `internal`. A failed resolution is not cached.
 */
export function resolveMethodAuth(method: DescMethod): ResolvedMethodAuth {
    const cached = resolvedCache.get(method);
    if (cached !== undefined) {
        return cached;
    }

    const result = computeMethodAuth(method);
    resolvedCache.set(method, result);
    return result;
}

/**
 * Compute the resolved auth for a method (uncached).
 */
function computeMethodAuth(method: DescMethod): ResolvedMethodAuth {
    const service = method.parent;

    // Read service-level defaults
    const hasServiceAuth = hasOption(service, service_auth);
    const svcAuth = hasServiceAuth ? getOption(service, service_auth) : undefined;

    // Read method-level overrides
    const hasMethodAuth = hasOption(method, method_auth);
    const mtdAuth = hasMethodAuth ? getOption(method, method_auth) : undefined;

    // If neither option is set, return default
    if (svcAuth === undefined && mtdAuth === undefined) {
        return DEFAULT_RESOLVED;
    }

    // Resolve `public` field with presence-aware override logic.
    // Method-level explicit setting takes priority over service-level.
    // Uses isFieldSet() to distinguish "not set" from "set to false" in proto2 optional bool.
    const methodPublicSet = mtdAuth !== undefined && isFieldSet(mtdAuth, MethodAuthSchema.field.public);
    const servicePublicSet = svcAuth !== undefined && isFieldSet(svcAuth, ServiceAuthSchema.field.public);
    const isPublic = methodPublicSet ? mtdAuth?.public === true : servicePublicSet ? svcAuth?.public === true : false;

    // Resolve `internal` field with the same presence-aware override logic as `public`.
    const methodInternalSet = mtdAuth !== undefined && isFieldSet(mtdAuth, MethodAuthSchema.field.internal);
    const serviceInternalSet = svcAuth !== undefined && isFieldSet(svcAuth, ServiceAuthSchema.field.internal);
    const isInternal = methodInternalSet ? mtdAuth?.internal === true : serviceInternalSet ? svcAuth?.internal === true : false;

    // A method is either reachable without an end-user identity because anyone
    // may call it (`public`) or because only a trusted peer service may call it
    // (`internal`). Both at once has no coherent reading — `public` would win and
    // silently open an internal method to everyone — so the contract is refused.
    if (isPublic && isInternal) {
        throw new Error(
            `@connectum/auth: ${service.typeName}/${method.name} is marked both public and internal, which contradicts itself ` +
                `(public skips every check, internal requires a trusted peer). ` +
                `To make the method public set "public: true, internal: false"; to make it internal remove "public".`,
        );
    }

    // Resolve `requires` field.
    // Method-level requires overrides service-level default_requires.
    // An empty `roles` or `scopes` list places no restriction on that dimension
    // and `requires {}` means "authenticated callers only" (see satisfiesRequirements).
    // A submessage field is undefined when not set in proto2.
    let requires: ResolvedMethodAuth["requires"];
    if (mtdAuth !== undefined && mtdAuth.requires !== undefined) {
        requires = {
            roles: mtdAuth.requires.roles,
            scopes: mtdAuth.requires.scopes,
        };
    } else if (svcAuth !== undefined && svcAuth.defaultRequires !== undefined) {
        requires = {
            roles: svcAuth.defaultRequires.roles,
            scopes: svcAuth.defaultRequires.scopes,
        };
    }

    // Resolve `policy` field.
    // Method-level policy overrides service-level default_policy.
    // For proto2 optional string: default is "", so non-empty means explicitly set.
    let policy: ResolvedMethodAuth["policy"];
    if (mtdAuth !== undefined && mtdAuth.policy !== "") {
        policy = normalizePolicy(mtdAuth.policy, method, "method_auth.policy");
    } else if (svcAuth !== undefined && svcAuth.defaultPolicy !== "") {
        policy = normalizePolicy(svcAuth.defaultPolicy, method, "service_auth.default_policy");
    }

    return { public: isPublic, internal: isInternal, policy, requires };
}

/**
 * Validate a non-empty policy string and narrow it to "allow" | "deny".
 *
 * Anything else (`"Allow"`, `"dney"`, `"permit"`) is a typo in the contract. Treating it
 * as "not set" would hand the decision to the interceptor default without a trace, so it
 * is an error that names the value, the method and the option. The comparison is
 * case-sensitive on purpose: the accepted spellings are exactly the two documented ones.
 */
function normalizePolicy(value: string, method: DescMethod, option: "method_auth.policy" | "service_auth.default_policy"): "allow" | "deny" {
    if (value === "allow") return "allow";
    if (value === "deny") return "deny";
    throw new Error(
        `@connectum/auth: invalid ${option} ${JSON.stringify(value)} on ${method.parent.typeName}/${method.name}; ` +
            `expected "allow" or "deny" (case-sensitive), or leave it unset to use the interceptor default.`,
    );
}

/**
 * Get the list of public method patterns from a set of service descriptors.
 *
 * Iterates over all methods in the given services, resolves their auth
 * configuration, and returns patterns for methods marked as `public`.
 *
 * The returned patterns follow the `"service.typeName/method.name"` format
 * used by `skipMethods` in auth interceptors.
 *
 * @param services - Service descriptors to scan
 * @returns Array of method patterns in `"ServiceTypeName/MethodName"` format
 *
 * @example
 * ```typescript
 * import { getPublicMethods } from '@connectum/auth/proto';
 *
 * const publicMethods = getPublicMethods([GreeterService, HealthService]);
 * // ["greet.v1.GreeterService/SayHello", "grpc.health.v1.Health/Check"]
 *
 * const authn = createAuthInterceptor({
 *   skipMethods: publicMethods,
 *   verifyCredentials: myVerifier,
 * });
 * ```
 */
export function getPublicMethods(services: readonly DescService[]): string[] {
    const patterns: string[] = [];

    for (const service of services) {
        for (const method of service.methods) {
            const resolved = resolveMethodAuth(method);
            if (resolved.public) {
                patterns.push(`${service.typeName}/${method.name}`);
            }
        }
    }

    return patterns;
}

/**
 * Get the list of internal method patterns from a set of service descriptors.
 *
 * Iterates over all methods in the given services, resolves their auth
 * configuration, and returns patterns for methods marked as `internal`.
 *
 * Mirrors {@link getPublicMethods}. Internal methods skip end-user (JWT)
 * authentication — feed these into the JWT auth interceptor's `skipMethods`
 * exactly like public methods — but, unlike public methods, they still require
 * an internal trust marker established by {@link createInternalAuthInterceptor}.
 *
 * The returned patterns follow the `"service.typeName/method.name"` format
 * used by `skipMethods` in auth interceptors.
 *
 * @param services - Service descriptors to scan
 * @returns Array of method patterns in `"ServiceTypeName/MethodName"` format
 *
 * @example
 * ```typescript
 * import { getInternalMethods, getPublicMethods } from '@connectum/auth/proto';
 *
 * // JWT auth skips both public and internal methods;
 * // the internal interceptor then enforces the trust marker on internal ones.
 * const jwtAuth = createJwtAuthInterceptor({
 *   jwksUri: '...',
 *   skipMethods: [...getPublicMethods(services), ...getInternalMethods(services)],
 * });
 * ```
 */
export function getInternalMethods(services: readonly DescService[]): string[] {
    const patterns: string[] = [];

    for (const service of services) {
        for (const method of service.methods) {
            const resolved = resolveMethodAuth(method);
            if (resolved.internal) {
                patterns.push(`${service.typeName}/${method.name}`);
            }
        }
    }

    return patterns;
}
