/**
 * Shared types for @connectum/auth
 *
 * @module types
 */

import type { Interceptor } from "@connectrpc/connect";

/**
 * Interceptor factory function type
 *
 * @template TOptions - Options type for the interceptor
 */
export type InterceptorFactory<TOptions = void> = TOptions extends void ? () => Interceptor : (options: TOptions) => Interceptor;

/**
 * Authenticated user context
 *
 * Represents the result of authentication. Set by auth interceptor,
 * accessible via getAuthContext() in handlers and downstream interceptors.
 */
export interface AuthContext {
    /** Authenticated subject identifier (user ID, service account, etc.) */
    readonly subject: string;
    /** Human-readable display name */
    readonly name?: string | undefined;
    /** Assigned roles (e.g., ["admin", "user"]) */
    readonly roles: ReadonlyArray<string>;
    /** Granted scopes (e.g., ["read", "write"]) */
    readonly scopes: ReadonlyArray<string>;
    /** Raw claims from the credential (JWT claims, API key metadata, etc.) */
    readonly claims: Readonly<Record<string, unknown>>;
    /** Credential type identifier (e.g., "jwt", "api-key", "mtls") */
    readonly type: string;
    /** Credential expiration time */
    readonly expiresAt?: Date | undefined;
}

/**
 * Standard header names for auth context propagation.
 *
 * Used for cross-service context propagation (similar to Envoy credential injection).
 * The auth interceptor sets these headers when propagateHeaders is true.
 *
 * WARNING: These headers are trusted ONLY in service-to-service communication
 * where transport security (mTLS) is established. Never trust these headers
 * from external clients without using createTrustedHeadersReader().
 */
export const AUTH_HEADERS = {
    /** Authenticated subject identifier */
    SUBJECT: "x-auth-subject",
    /** JSON-encoded roles array */
    ROLES: "x-auth-roles",
    /** Space-separated scopes */
    SCOPES: "x-auth-scopes",
    /** JSON-encoded claims object */
    CLAIMS: "x-auth-claims",
    /** Credential type (jwt, api-key, mtls, etc.) */
    TYPE: "x-auth-type",
} as const;

/**
 * Authorization rule effect
 */
export const AuthzEffect = {
    ALLOW: "allow",
    DENY: "deny",
} as const;

export type AuthzEffect = (typeof AuthzEffect)[keyof typeof AuthzEffect];

/**
 * Authorization rule definition
 */
export interface AuthzRule {
    /** Rule name for logging/debugging */
    readonly name: string;
    /** Method patterns to match (e.g., "admin.v1.AdminService/*", "user.v1.UserService/DeleteUser") */
    readonly methods: ReadonlyArray<string>;
    /** Effect when rule matches */
    readonly effect: AuthzEffect;
    /** Required roles/scopes for this rule */
    readonly requires?:
        | {
              readonly roles?: ReadonlyArray<string>;
              readonly scopes?: ReadonlyArray<string>;
          }
        | undefined;
}

/**
 * Generic auth interceptor options
 */
export interface AuthInterceptorOptions {
    /**
     * Extract credentials from request.
     * Default: extracts Bearer token from Authorization header.
     *
     * @param req - Request with headers
     * @returns Credential string or null if no credentials found
     */
    extractCredentials?: (req: { header: Headers }) => string | null | Promise<string | null>;

    /**
     * Verify credentials and return auth context.
     * REQUIRED. Must throw on invalid credentials.
     *
     * @param credentials - Extracted credential string
     * @returns AuthContext for valid credentials
     */
    verifyCredentials: (credentials: string) => AuthContext | Promise<AuthContext>;

    /**
     * Methods to skip authentication for.
     * Patterns: "Service/Method" or "Service/*"
     * @default [] (health and reflection methods are NOT auto-skipped)
     */
    skipMethods?: string[] | undefined;

    /**
     * Propagate auth context as headers for downstream services.
     * @default false
     */
    propagateHeaders?: boolean | undefined;

    /**
     * Enrich OpenTelemetry spans with auth context.
     * Requires @connectum/otel as optional peer dependency.
     * @default false
     */
    otelEnrichment?: boolean | undefined;
}

/**
 * JWT auth interceptor options
 */
export interface JwtAuthInterceptorOptions {
    /** JWKS endpoint URL for remote key set */
    jwksUri?: string | undefined;
    /** HMAC symmetric secret (for HS256/HS384/HS512) */
    secret?: string | undefined;
    /** Asymmetric public key */
    publicKey?: CryptoKey | undefined;
    /** Expected issuer(s) */
    issuer?: string | string[] | undefined;
    /** Expected audience(s) */
    audience?: string | string[] | undefined;
    /** Allowed algorithms */
    algorithms?: string[] | undefined;
    /**
     * Mapping from JWT claims to AuthContext fields.
     * Supports dot-notation paths (e.g., "realm_access.roles").
     */
    claimsMapping?:
        | {
              subject?: string | undefined;
              name?: string | undefined;
              roles?: string | undefined;
              scopes?: string | undefined;
          }
        | undefined;
    /**
     * Methods to skip authentication for.
     * @default []
     */
    skipMethods?: string[] | undefined;
    /**
     * Propagate auth context as headers for downstream services.
     * @default false
     */
    propagateHeaders?: boolean | undefined;
    /**
     * Enrich OpenTelemetry spans with auth context.
     * @default false
     */
    otelEnrichment?: boolean | undefined;
}

/**
 * Authorization interceptor options
 */
export interface AuthzInterceptorOptions {
    /**
     * Default policy when no rule matches.
     * @default "deny"
     */
    defaultPolicy?: AuthzEffect | undefined;

    /**
     * Declarative authorization rules.
     * Evaluated in order; first matching rule wins.
     */
    rules?: AuthzRule[] | undefined;

    /**
     * Programmatic authorization callback.
     * Called after rule evaluation if no rule matched,
     * or always if no rules are defined.
     *
     * @param context - Authenticated user context
     * @param req - Request info (service and method names)
     * @returns true if authorized, false otherwise
     */
    authorize?: (context: AuthContext, req: { service: string; method: string }) => boolean | Promise<boolean>;

    /**
     * Methods to skip authorization for.
     * @default []
     */
    skipMethods?: string[] | undefined;
}

/**
 * Trusted headers reader options
 */
export interface TrustedHeadersReaderOptions {
    /**
     * Trusted proxy IP addresses or CIDR ranges.
     * REQUIRED. Fail-closed: if empty, no headers are trusted.
     */
    trustedProxies: string[];
}
