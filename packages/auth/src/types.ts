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
    /**
     * Set to `percent-utf8` when the sender encoded a text (subject, name, type or scope) as
     * `utf-8''` plus percent-encoded UTF-8. Readers decode `utf-8''` texts only when it is present.
     */
    ENCODING: "x-auth-encoding",
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
    /** Effect when rule matches. Exactly `"allow"` or `"deny"`; any other value makes the factory throw. */
    readonly effect: AuthzEffect;
    /**
     * Required roles/scopes for this rule.
     *
     * - `roles` uses "any-of" semantics: user needs at least one of the listed roles.
     * - `scopes` uses "all-of" semantics: user needs every listed scope.
     * - An empty or omitted list places no restriction on that dimension; `requires: {}`
     *   therefore matches any authenticated caller.
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
    /**
     * Cache entry time-to-live in milliseconds. Must be finite and greater than 0;
     * anything else (0, negative, `NaN`, `Infinity`) throws `RangeError` when the interceptor is created.
     */
    readonly ttl: number;
    /**
     * Maximum number of cached entries. Must be an integer of at least 1;
     * anything else throws `RangeError` when the interceptor is created.
     * @default 1000
     */
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
     * Error contract: a thrown `ConnectError` reaches the client unchanged (its code and
     * message are sent verbatim, so keep the text public); any other thrown value becomes
     * `Unauthenticated: Authentication failed` and its text is not sent. A returned value that is
     * not an `AuthContext` (`null`, `undefined`, `false`, `{}`, a missing or mistyped `subject`,
     * `type`, `roles`, `scopes` or `claims`) is treated the same way and is never cached.
     *
     * @param credentials - Extracted credential string
     * @returns AuthContext for valid credentials
     */
    verifyCredentials: (credentials: string) => AuthContext | Promise<AuthContext>;

    /**
     * Methods to skip authentication for.
     * Patterns: "Service/Method" or "Service/*"; any other pattern, a partial wildcard included, throws
     * when the interceptor is created. The catch-all `"*"` is refused: creating the
     * interceptor throws, because it would switch authentication off for every method
     * (to disable the interceptor, do not register it).
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
     *
     * The cache stores a private copy of the identity, and every request served from it receives its
     * own copy (including `roles`, `scopes` and `claims`, nested plain objects and arrays too), so a
     * handler that changes its `AuthContext` does not change what a later request with the same
     * credential receives. Each hit costs one pass over the identity, proportional to its size.
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
    /**
     * Expected issuer(s). Omit the option to skip the check. A present value must be a non-empty
     * string or an array of non-empty strings; an empty string throws when the interceptor is created.
     */
    issuer?: string | string[] | undefined;
    /**
     * Expected audience(s). Omit the option to skip the check. A present value must be a non-empty
     * string or an array of non-empty strings; an empty string throws when the interceptor is created.
     */
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
     * Number (seconds) or string (e.g., "2h", "7d"). Omit the option to skip the check; `0`, a
     * negative or non-finite number and a blank string throw when the interceptor is created.
     */
    maxTokenAge?: number | string | undefined;
    /**
     * Reject a token that has no `exp` (expiration time) claim. A signed token
     * without `exp` never expires, so a leaked one stays valid until the signing
     * key is rotated; RFC 9068 requires `exp` in JWT access tokens. Set `false`
     * only for a trusted issuer that cannot add `exp`.
     * @default true
     */
    requireExpiration?: boolean | undefined;
    /**
     * Methods to skip authentication for. The catch-all `"*"` is refused (creation throws).
     * @default []
     */
    skipMethods?: string[] | undefined;
    /**
     * Propagate auth context as headers for downstream services.
     * A subject, type, name or scope containing NUL, CR or LF is rejected with
     * `Unauthenticated` (and never cached) while this is on.
     * Text above U+00FF is written as `utf-8''` plus percent-encoded UTF-8 (with `x-auth-encoding: percent-utf8`) and read back by the receiver.
     * An identity that does not fit its header (subject over 512 characters, type over 128, name over
     * 256, serialized roles, scopes or claims over 8192) is rejected too, instead of being cut or left out.
     * @default false
     */
    propagateHeaders?: boolean | undefined;
}

/**
 * Authorization interceptor options
 */
export interface AuthzInterceptorOptions {
    /**
     * Default policy when no rule matches. Exactly `"allow"` or `"deny"`; any other value
     * (`"Deny"`, `""`, `null`) makes the factory throw instead of being read as allow.
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
     * @returns `true` if authorized. Any other result, including a truthy non-boolean such as the string `"false"`, denies the call.
     */
    authorize?: (context: AuthContext, req: { service: string; method: string }) => boolean | Promise<boolean>;

    /**
     * Methods to skip authorization for. The catch-all `"*"` is refused (creation throws);
     * `"*"` remains valid in the `methods` of a rule.
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
    /**
     * Header containing the roles: a JSON array of strings (`["admin","editor"]`) or a
     * comma-separated list (`admin, editor`). Any value that is not a JSON array, including
     * JSON of another kind such as `123` or `true`, is read as a comma-separated list.
     */
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
        /** Header set by the gateway to prove trust. A non-empty string; anything else throws when the interceptor is created. */
        readonly header: string;
        /**
         * Accepted values for the trust header: shared secrets compared exactly, and, only with
         * `allowCallerControlledCidr`, IPv4 CIDR blocks such as `10.0.0.0/8`. Every entry must be
         * a non-empty string, so an unset environment variable (`[process.env.GATEWAY_SECRET]`
         * gives `[undefined]`) throws when the interceptor is created instead of failing every request.
         */
        readonly expectedValues: string[];
        /**
         * Allow IPv4 CIDR blocks in `expectedValues`. Off by default: with a CIDR block present and
         * this option unset, creating the interceptor throws.
         *
         * A block is matched against the value of the trust header, and a caller that reaches the
         * service directly chooses that value itself, so `10.0.0.0/8` admits anyone who sends
         * `10.9.9.9`. Enable it only when a trusted upstream overwrites the header on every request
         * and no client can reach the service without passing through it. Trust based on the peer
         * address of the connection belongs in the mTLS or mesh-identity trust helpers.
         * @default false
         */
        readonly allowCallerControlledCidr?: boolean | undefined;
    };
    /** Headers to strip from the request after extraction (prevent spoofing) */
    readonly stripHeaders?: string[] | undefined;
    /** Methods to skip authentication for. The catch-all `"*"` is refused (creation throws). */
    readonly skipMethods?: string[] | undefined;
    /**
     * Propagate auth context as headers for downstream services.
     * An identity containing NUL, CR or LF is rejected with `Unauthenticated` while this is on. Text above U+00FF is written as `utf-8''` plus percent-encoded UTF-8 (with `x-auth-encoding: percent-utf8`) and read back by the receiver. An identity that does not fit its header (subject over 512 characters, type over 128, name over 256, serialized roles, scopes or claims over 8192) is rejected too, never cut or left out.
     */
    readonly propagateHeaders?: boolean | undefined;
    /**
     * Credential type used when the gateway sends no type header.
     * A value containing NUL, CR or LF throws when the interceptor is created. With `propagateHeaders`
     * on, an empty value, a value longer than 128 characters and a value with a lone surrogate throw
     * too, because the value is written into `x-auth-type`; with it off they are accepted.
     * @default "gateway"
     */
    readonly defaultType?: string | undefined;
}

/**
 * A pluggable internal trust source (ADR-029).
 *
 * Given the incoming request, returns an {@link AuthContext} for the calling
 * service when the internal trust marker is present and valid, or `null` when
 * it is missing/invalid. {@link createInternalAuthInterceptor} converts `null`
 * (and any thrown error from the trust source) into `Code.Unauthenticated`.
 *
 * The returned `AuthContext.subject` is the service identity; `roles`/`scopes`
 * come from the trust source (allow-list entry or verified token claims) so the
 * call composes with the existing `requires {roles,scopes}` authz model.
 *
 * @param req - The request (read-only access to headers).
 * @returns AuthContext for a trusted internal caller, or null to reject. A result that is not an
 *   `AuthContext` (a truthy `true`, `{}`, a sparse `roles` list) is rejected like `null`.
 */
export type InternalTrustSource = (req: { header: Headers }) => AuthContext | null | Promise<AuthContext | null>;

/**
 * Options for {@link createInternalAuthInterceptor}.
 */
export interface InternalAuthInterceptorOptions {
    /**
     * The trust source that authorizes an internal call.
     *
     * Use one of the provided factories — {@link meshIdentityTrust} (production
     * default, per-service via the mesh), {@link signedTokenTrust} (non-mesh,
     * per-service JWT/JWKS with mandatory issuer-bound key selection), or
     * {@link sharedSecretTrust} (dev-only fallback) — or supply a custom one.
     */
    readonly trustSource: InternalTrustSource;
    /**
     * Method patterns that are internal (service-to-service). Typically the
     * output of `getInternalMethods(services)`. The interceptor enforces the
     * trust marker only on these methods; all other methods pass through
     * unchanged (no-op).
     *
     * Patterns: `"Service/Method"`, `"Service/*"`, or `"*"`. Any other pattern, a partial
     * wildcard included, throws when the interceptor is created.
     */
    readonly internalMethods: readonly string[];
}

/**
 * An allow-list entry for {@link meshIdentityTrust}, mapping a verified mesh
 * identity (the forwarded peer principal) to its authorization context.
 */
export interface MeshIdentityEntry {
    /**
     * The mesh-forwarded peer identity to match, e.g. an Istio short-form
     * ServiceAccount principal `cluster.local/ns/<ns>/sa/<name>` or a SPIFFE id.
     */
    readonly principal: string;
    /** Roles granted to this caller (compose via `requires {roles}`). */
    readonly roles?: readonly string[] | undefined;
    /** Scopes granted to this caller (compose via `requires {scopes}`). */
    readonly scopes?: readonly string[] | undefined;
    /** Optional human-readable name for the calling service. */
    readonly name?: string | undefined;
}

/**
 * Options for {@link meshIdentityTrust}.
 */
export interface MeshIdentityTrustOptions {
    /**
     * Allow-list of permitted mesh identities. Each entry maps a forwarded peer
     * principal to its roles/scopes. A request whose identity is not on the
     * list is rejected.
     */
    readonly allowlist: readonly MeshIdentityEntry[];
    /**
     * Header carrying the mesh-forwarded peer identity.
     * @default "x-forwarded-client-principal"
     */
    readonly header?: string | undefined;
    /** Credential type set on the resulting AuthContext. @default "mesh" */
    readonly type?: string | undefined;
}

/**
 * Per-issuer JWKS configuration for {@link signedTokenTrust}.
 *
 * The JWKS lookup is issuer-bound: the keyset is selected by the token's `iss`
 * claim and verification is pinned to that same issuer. This is a hard security
 * requirement — a single shared JWKS holding multiple services' keys does NOT
 * contain compromise (jose resolves the key by `kid` independently of `iss`).
 */
export interface SignedTokenIssuer {
    /** The issuer's JWKS endpoint URL (its own keyset only). */
    readonly jwksUri: string;
    /** Expected audience(s) for tokens from this issuer. */
    readonly audience?: string | string[] | undefined;
    /** Allowed signing algorithms. @default ["RS256"] */
    readonly algorithms?: string[] | undefined;
    /** Maximum token age (seconds or string like "2h"). */
    readonly maxTokenAge?: number | string | undefined;
    /**
     * Reject a token from this issuer that has no `exp` claim: a signed token
     * without `exp` never expires. Set `false` only for an issuer that cannot add it.
     * @default true
     */
    readonly requireExpiration?: boolean | undefined;
    /**
     * Mapping from token claims to AuthContext fields (dot-notation paths).
     *
     * Only a claim named here is read. `subject` is the verified `iss` unless
     * `claimsMapping.subject` names another claim (then a missing or non-string value
     * rejects the call); `roles` and `scopes` are empty unless mapped, and the standard
     * `scope` claim grants nothing until `claimsMapping.scopes` points at it.
     */
    readonly claimsMapping?:
        | {
              readonly subject?: string | undefined;
              readonly name?: string | undefined;
              readonly roles?: string | undefined;
              readonly scopes?: string | undefined;
          }
        | undefined;
}

/**
 * Options for {@link signedTokenTrust}.
 */
export interface SignedTokenTrustOptions {
    /**
     * Per-issuer configuration keyed by the issuer (`iss`) value. The keyset is
     * selected by the token's claimed issuer and verification is pinned to that
     * same issuer — never a single shared keyset across issuers.
     */
    readonly issuers: Readonly<Record<string, SignedTokenIssuer>>;
    /**
     * Header carrying the service token. The value may be a bare token or a
     * `Bearer <token>` value.
     * @default "x-internal-token"
     */
    readonly header?: string | undefined;
    /** Credential type set on the resulting AuthContext. @default "service" */
    readonly type?: string | undefined;
}

/**
 * Options for {@link sharedSecretTrust}.
 *
 * DEV-ONLY: a single shared secret is NOT per-service — one compromise forges
 * all callers. Use {@link meshIdentityTrust} or {@link signedTokenTrust} in
 * production. See ADR-029.
 */
export interface SharedSecretTrustOptions {
    /** The shared secret, constant-time compared against the header value. */
    readonly secret: string;
    /**
     * Header carrying the shared secret.
     * @default "x-internal-secret"
     */
    readonly header?: string | undefined;
    /**
     * Subject identity assigned to a trusted call.
     * @default "internal"
     */
    readonly subject?: string | undefined;
    /** Roles granted to a trusted caller. */
    readonly roles?: readonly string[] | undefined;
    /** Scopes granted to a trusted caller. */
    readonly scopes?: readonly string[] | undefined;
    /** Credential type set on the resulting AuthContext. @default "internal" */
    readonly type?: string | undefined;
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
     * Error contract: a thrown `ConnectError` reaches the client unchanged (code and message
     * verbatim, so keep the text public); any other thrown value becomes
     * `Unauthenticated: Session verification failed`. The same holds for `mapSession`
     * (fixed text `Session mapping failed`).
     *
     * @param token - Session token string
     * @param headers - Request headers (for additional context)
     * @returns Raw session data
     */
    readonly verifySession: (token: string, headers: Headers) => unknown | Promise<unknown>;
    /**
     * Map raw session data to AuthContext.
     *
     * A result that is not an `AuthContext` (`null`, `undefined`, `false`, `{}`, a missing or
     * mistyped `subject`, `type`, `roles`, `scopes` or `claims`) ends the call with
     * `Unauthenticated: Session mapping failed`; it is never cached.
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
    /**
     * LRU cache for session verification results. Every request receives its own copy of the stored
     * identity, as described for `AuthInterceptorOptions.cache`.
     */
    readonly cache?: CacheOptions | undefined;
    /** Methods to skip authentication for. The catch-all `"*"` is refused (creation throws). */
    readonly skipMethods?: string[] | undefined;
    /**
     * Propagate auth context as headers for downstream services.
     * An identity containing NUL, CR or LF is rejected with `Unauthenticated` (and never cached) while this is on. Text above U+00FF is written as `utf-8''` plus percent-encoded UTF-8 (with `x-auth-encoding: percent-utf8`) and read back by the receiver. An identity that does not fit its header (subject over 512 characters, type over 128, name over 256, serialized roles, scopes or claims over 8192) is rejected too, never cut or left out.
     */
    readonly propagateHeaders?: boolean | undefined;
    /**
     * Filter which claims are propagated in headers.
     * When set, only listed claim keys are included in x-auth-claims header.
     * When not set, all claims are propagated.
     */
    readonly propagatedClaims?: string[] | undefined;
}

/**
 * Client-side Bearer token interceptor options.
 *
 * @see {@link createClientBearerInterceptor}
 */
export interface ClientBearerInterceptorOptions {
    /**
     * Bearer token value or async factory function.
     *
     * When a string is provided, the same token is sent with every request.
     * When a function is provided, it is called before each request to
     * support token refresh flows.
     *
     * A static token must be a non-empty string (anything else throws when the interceptor is
     * created). A factory that resolves to anything but a non-empty string fails that call with
     * `Code.Unauthenticated` before a request is sent; the header is never `Bearer undefined`.
     */
    readonly token: string | (() => Promise<string>);
}

/**
 * Client-side gateway service-to-service auth interceptor options.
 *
 * @see {@link createClientGatewayInterceptor}
 */
export interface ClientGatewayInterceptorOptions {
    /**
     * Shared secret for gateway trust verification. Creating the interceptor throws if it is empty,
     * contains NUL, CR, LF or a character above U+00FF, or starts or ends with a space or tab (the
     * platform removes that whitespace from a header value, so the secret would never match).
     */
    readonly secret: string;
    /**
     * Authenticated subject identifier (e.g., service name). Creating the interceptor throws if it
     * is empty, over 512 characters, or contains NUL, CR, LF or a lone surrogate (the header writer decides).
     */
    readonly subject: string;
    /**
     * Optional roles to propagate (JSON-encoded in header). Creating the interceptor throws if this
     * is not an array of at most 8192 strings without holes whose JSON form fits the roles header
     * (measured as the header writer measures it, with every character above U+00FF written as six characters).
     * The roles are checked again on each call, so a change made after creation is refused with `InvalidArgument`.
     */
    readonly roles?: string[] | undefined;
}

/**
 * Proto-based authorization interceptor options.
 *
 * Uses proto custom options (connectum.auth.v1) for declarative authorization
 * rules defined in .proto files. Falls back to programmatic rules and callbacks.
 */
export interface ProtoAuthzInterceptorOptions {
    /**
     * Default policy when no proto option and no rule match. Exactly `"allow"` or `"deny"`;
     * any other value (`"Deny"`, `""`, `null`) makes the factory throw instead of being read as allow.
     * @default "deny"
     */
    defaultPolicy?: AuthzEffect | undefined;
    /**
     * Additional programmatic rules, evaluated after proto options.
     * Rules are evaluated in order; first matching rule wins.
     */
    rules?: AuthzRule[] | undefined;
    /**
     * Programmatic authorization callback.
     * Called when neither proto options nor programmatic rules match.
     *
     * @param context - Authenticated user context
     * @param req - Request info (service and method names)
     * @returns `true` if authorized. Any other result, including a truthy non-boolean such as the string `"false"`, denies the call.
     */
    authorize?: (context: AuthContext, req: { service: string; method: string }) => boolean | Promise<boolean>;
}
