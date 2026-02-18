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
 * from external clients without using createGatewayAuthInterceptor().
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
    /** Human-readable display name */
    NAME: "x-auth-name",
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
 * Authorization rule definition.
 *
 * When a rule has `requires`, the match semantics are:
 * - **roles**: "any-of" -- the user must have **at least one** of the listed roles.
 * - **scopes**: "all-of" -- the user must have **every** listed scope.
 */
export interface AuthzRule {
    /** Rule name for logging/debugging */
    readonly name: string;
    /** Method patterns to match (e.g., "admin.v1.AdminService/*", "user.v1.UserService/DeleteUser") */
    readonly methods: ReadonlyArray<string>;
    /** Effect when rule matches */
    readonly effect: AuthzEffect;
    /**
     * Required roles/scopes for this rule.
     *
     * - `roles` uses "any-of" semantics: user needs at least one of the listed roles.
     * - `scopes` uses "all-of" semantics: user needs every listed scope.
     */
    readonly requires?:
        | {
              readonly roles?: ReadonlyArray<string>;
              readonly scopes?: ReadonlyArray<string>;
          }
        | undefined;
}

/**
 * LRU cache configuration for credentials verification
 */
export interface CacheOptions {
    /** Cache entry time-to-live in milliseconds */
    readonly ttl: number;
    /** Maximum number of cached entries */
    readonly maxSize?: number | undefined;
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
     * LRU cache for credentials verification results.
     * Caches AuthContext by credential string to reduce verification overhead.
     */
    cache?: CacheOptions | undefined;

    /**
     * Filter which claims are propagated in headers (SEC-001).
     * When set, only listed claim keys are included in x-auth-claims header.
     * When not set, all claims are propagated.
     */
    propagatedClaims?: string[] | undefined;
}

/**
 * JWT auth interceptor options
 */
export interface JwtAuthInterceptorOptions {
    /** JWKS endpoint URL for remote key set */
    jwksUri?: string | undefined;
    /** HMAC symmetric secret (for HS256/HS384/HS512) */
    secret?: string | undefined;
    /**
     * Asymmetric public key for JWT signature verification.
     *
     * Supported algorithms:
     * - **RSA**: RS256, RS384, RS512
     * - **RSA-PSS**: PS256, PS384, PS512
     * - **EC (ECDSA)**: ES256, ES384, ES512
     * - **EdDSA**: Ed25519, Ed448
     *
     * Import a PEM-encoded key via Web Crypto API:
     *
     * @example RSA public key
     * ```typescript
     * const rsaKey = await crypto.subtle.importKey(
     *   "spki",
     *   pemToArrayBuffer(rsaPem),
     *   { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
     *   true,
     *   ["verify"],
     * );
     * ```
     *
     * @example EC public key
     * ```typescript
     * const ecKey = await crypto.subtle.importKey(
     *   "spki",
     *   pemToArrayBuffer(ecPem),
     *   { name: "ECDSA", namedCurve: "P-256" },
     *   true,
     *   ["verify"],
     * );
     * ```
     *
     * @see {@link https://github.com/panva/jose/blob/main/docs/types/types.CryptoKey.md | jose CryptoKey documentation}
     */
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
     * Maximum token age.
     * Passed to jose jwtVerify options.
     * Number (seconds) or string (e.g., "2h", "7d").
     */
    maxTokenAge?: number | string | undefined;
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
 * Header name mapping for gateway auth context extraction.
 *
 * Maps AuthContext fields to custom header names used by the API gateway.
 */
export interface GatewayHeaderMapping {
    /** Header containing the authenticated subject */
    readonly subject: string;
    /** Header containing the display name */
    readonly name?: string | undefined;
    /** Header containing JSON-encoded roles array */
    readonly roles?: string | undefined;
    /** Header containing space-separated scopes */
    readonly scopes?: string | undefined;
    /** Header containing credential type */
    readonly type?: string | undefined;
    /** Header containing JSON-encoded claims */
    readonly claims?: string | undefined;
}

/**
 * Gateway auth interceptor options.
 *
 * For services behind an API gateway that has already performed authentication.
 * Extracts auth context from gateway-injected headers.
 */
export interface GatewayAuthInterceptorOptions {
    /** Mapping from AuthContext fields to gateway header names */
    readonly headerMapping: GatewayHeaderMapping;
    /** Trust verification: check that request came from a trusted gateway */
    readonly trustSource: {
        /** Header set by the gateway to prove trust */
        readonly header: string;
        /** Accepted values for the trust header */
        readonly expectedValues: string[];
    };
    /** Headers to strip from the request after extraction (prevent spoofing) */
    readonly stripHeaders?: string[] | undefined;
    /** Methods to skip authentication for */
    readonly skipMethods?: string[] | undefined;
    /** Propagate auth context as headers for downstream services */
    readonly propagateHeaders?: boolean | undefined;
    /** Default credential type when not provided by gateway */
    readonly defaultType?: string | undefined;
}

/**
 * Session-based auth interceptor options.
 *
 * Two-step authentication: verify session token, then map session data to AuthContext.
 */
export interface SessionAuthInterceptorOptions {
    /**
     * Verify session token and return raw session data.
     * Must throw on invalid/expired sessions.
     *
     * @param token - Session token string
     * @param headers - Request headers (for additional context)
     * @returns Raw session data
     */
    readonly verifySession: (token: string, headers: Headers) => unknown | Promise<unknown>;
    /**
     * Map raw session data to AuthContext.
     *
     * @param session - Raw session data from verifySession
     * @returns Normalized auth context
     */
    readonly mapSession: (session: unknown) => AuthContext | Promise<AuthContext>;
    /**
     * Custom token extraction.
     * Default: extracts Bearer token from Authorization header.
     */
    readonly extractToken?: ((req: { header: Headers }) => string | null | Promise<string | null>) | undefined;
    /** LRU cache for session verification results */
    readonly cache?: CacheOptions | undefined;
    /** Methods to skip authentication for */
    readonly skipMethods?: string[] | undefined;
    /** Propagate auth context as headers for downstream services */
    readonly propagateHeaders?: boolean | undefined;
    /**
     * Filter which claims are propagated in headers.
     * When set, only listed claim keys are included in x-auth-claims header.
     * When not set, all claims are propagated.
     */
    readonly propagatedClaims?: string[] | undefined;
}
