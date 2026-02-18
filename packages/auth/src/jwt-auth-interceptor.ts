/**
 * JWT authentication interceptor
 *
 * Convenience wrapper for JWT-based authentication using the jose library.
 * Supports JWKS remote key sets, HMAC secrets, and asymmetric public keys.
 *
 * @module jwt-auth-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import * as jose from "jose";
import { createAuthInterceptor } from "./auth-interceptor.ts";
import type { AuthContext, JwtAuthInterceptorOptions } from "./types.ts";

/**
 * Resolve a value at a dot-notation path in an object.
 *
 * @example getNestedValue({ a: { b: [1, 2] } }, "a.b") // [1, 2]
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    let current: unknown = obj;
    for (const key of path.split(".")) {
        if (current === null || current === undefined || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/**
 * Get minimum HMAC key size in bytes per RFC 7518.
 * HS256 requires 32 bytes, HS384 requires 48, HS512 requires 64.
 */
function getMinHmacKeyBytes(algorithms?: string[]): number {
    if (!algorithms) return 32;
    if (algorithms.includes("HS512")) return 64;
    if (algorithms.includes("HS384")) return 48;
    return 32;
}

/**
 * Build a JWT verification function from options.
 *
 * Separates JWKS (dynamic key resolution) from static keys (HMAC / asymmetric)
 * to satisfy jose's overloaded jwtVerify signatures.
 *
 * Priority: jwksUri > publicKey > secret
 */
function buildVerifier(options: JwtAuthInterceptorOptions, verifyOptions: jose.JWTVerifyOptions): (token: string) => Promise<jose.JWTVerifyResult> {
    if (options.jwksUri) {
        const jwks = jose.createRemoteJWKSet(new URL(options.jwksUri));
        return (token) => jose.jwtVerify(token, jwks, verifyOptions);
    }
    if (options.publicKey) {
        const key = options.publicKey;
        return (token) => jose.jwtVerify(token, key, verifyOptions);
    }
    if (options.secret) {
        const key = new TextEncoder().encode(options.secret);
        const minBytes = getMinHmacKeyBytes(options.algorithms);
        if (key.byteLength < minBytes) {
            throw new Error(
                `@connectum/auth: HMAC secret must be at least ${minBytes} bytes (${minBytes * 8} bits) per RFC 7518. ` +
                    `Got ${key.byteLength} bytes. Generate with: openssl rand -base64 ${minBytes}`,
            );
        }
        return (token) => jose.jwtVerify(token, key, verifyOptions);
    }
    throw new Error("@connectum/auth: JWT interceptor requires one of: jwksUri, secret, or publicKey");
}

/**
 * Mutable intermediate type for claim mapping results.
 */
interface MappedClaims {
    subject?: string;
    name?: string;
    roles?: string[];
    scopes?: string[];
}

/**
 * Map JWT claims to AuthContext using configurable claim paths.
 */
function mapClaimsToContext(payload: jose.JWTPayload, mapping: NonNullable<JwtAuthInterceptorOptions["claimsMapping"]>): MappedClaims {
    const result: MappedClaims = {};
    const claims = payload as Record<string, unknown>;

    // Subject
    if (mapping.subject) {
        const val = getNestedValue(claims, mapping.subject);
        if (typeof val === "string") {
            result.subject = val;
        }
    }

    // Name
    if (mapping.name) {
        const val = getNestedValue(claims, mapping.name);
        if (typeof val === "string") {
            result.name = val;
        }
    }

    // Roles
    if (mapping.roles) {
        const val = getNestedValue(claims, mapping.roles);
        if (Array.isArray(val)) {
            result.roles = val.filter((r): r is string => typeof r === "string");
        }
    }

    // Scopes (can be space-separated string or array)
    if (mapping.scopes) {
        const val = getNestedValue(claims, mapping.scopes);
        if (typeof val === "string") {
            result.scopes = val.split(" ").filter(Boolean);
        } else if (Array.isArray(val)) {
            result.scopes = val.filter((s): s is string => typeof s === "string");
        }
    }

    return result;
}

/**
 * Throw an Unauthenticated error for a missing JWT subject claim.
 */
function throwMissingSubject(): never {
    throw new ConnectError("JWT missing subject claim", Code.Unauthenticated);
}

/**
 * Create a JWT authentication interceptor.
 *
 * Convenience wrapper around createAuthInterceptor() that handles
 * JWT extraction from Authorization header, verification via jose,
 * and standard claim mapping to AuthContext.
 *
 * @param options - JWT authentication options
 * @returns ConnectRPC interceptor
 *
 * @example JWKS-based JWT auth (Auth0, Keycloak, etc.)
 * ```typescript
 * import { createJwtAuthInterceptor } from '@connectum/auth';
 *
 * const jwtAuth = createJwtAuthInterceptor({
 *   jwksUri: 'https://auth.example.com/.well-known/jwks.json',
 *   issuer: 'https://auth.example.com/',
 *   audience: 'my-api',
 *   claimsMapping: {
 *     roles: 'realm_access.roles',
 *     scopes: 'scope',
 *   },
 * });
 * ```
 *
 * @example HMAC secret (testing / simple setups)
 * ```typescript
 * const jwtAuth = createJwtAuthInterceptor({
 *   secret: process.env.JWT_SECRET,
 *   issuer: 'my-service',
 * });
 * ```
 */
export function createJwtAuthInterceptor(options: JwtAuthInterceptorOptions): Interceptor {
    const { claimsMapping = {}, skipMethods, propagateHeaders } = options;

    const verifyOptions: jose.JWTVerifyOptions = {};
    if (options.issuer) {
        verifyOptions.issuer = options.issuer;
    }
    if (options.audience) {
        verifyOptions.audience = options.audience;
    }
    if (options.algorithms) {
        verifyOptions.algorithms = options.algorithms;
    }
    if (options.maxTokenAge) {
        verifyOptions.maxTokenAge = options.maxTokenAge;
    }

    const verify = buildVerifier(options, verifyOptions);

    return createAuthInterceptor({
        skipMethods,
        propagateHeaders,
        verifyCredentials: async (token: string): Promise<AuthContext> => {
            const { payload } = await verify(token);

            // Map standard + custom claims
            const mapped = mapClaimsToContext(payload, claimsMapping);
            const claims = payload as Record<string, unknown>;

            return {
                subject: mapped.subject ?? payload.sub ?? throwMissingSubject(),
                name: mapped.name ?? (typeof claims.name === "string" ? claims.name : undefined),
                roles: mapped.roles ?? [],
                scopes: mapped.scopes ?? (typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : []),
                claims,
                type: "jwt",
                expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
            };
        },
    });
}
