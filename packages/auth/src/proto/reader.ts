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
    /** Authorization policy: "allow", "deny", or undefined (use interceptor default). */
    readonly policy: "allow" | "deny" | undefined;
    /** Required roles and scopes, or undefined if none specified. */
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
 * method.public       -> service.public        -> false
 * method.requires     -> service.default_requires -> undefined
 * method.policy       -> service.default_policy    -> undefined
 * ```
 *
 * @param method - The protobuf method descriptor
 * @returns Resolved authorization configuration
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
    const isPublic = methodPublicSet ? mtdAuth!.public === true : servicePublicSet ? svcAuth!.public === true : false;

    // Resolve `requires` field.
    // Method-level requires overrides service-level default_requires.
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
        policy = normalizePolicy(mtdAuth.policy);
    } else if (svcAuth !== undefined && svcAuth.defaultPolicy !== "") {
        policy = normalizePolicy(svcAuth.defaultPolicy);
    }

    return { public: isPublic, policy, requires };
}

/**
 * Normalize a policy string to "allow" | "deny" | undefined.
 */
function normalizePolicy(value: string): "allow" | "deny" | undefined {
    if (value === "allow") return "allow";
    if (value === "deny") return "deny";
    return undefined;
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
