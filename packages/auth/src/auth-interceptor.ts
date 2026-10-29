/**
 * Generic authentication interceptor
 *
 * Provides pluggable authentication for any credential type.
 * Extracts credentials, verifies them, and stores AuthContext
 * in AsyncLocalStorage for downstream access.
 *
 * @module auth-interceptor
 */

import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { isAuthContext } from "./auth-context-check.ts";
import { LruCache } from "./cache.ts";
import { copyAuthContext } from "./cached-identity.ts";
import { propagateAuthHeaders } from "./headers.ts";
import { assertNoCatchAllSkip, matchesMethodPattern } from "./method-match.ts";
import { runWithAuthContext } from "./run-with-auth-context.ts";
import type { AuthContext, AuthInterceptorOptions } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/**
 * Default credential extractor.
 * Extracts Bearer token from Authorization header.
 */
function defaultExtractCredentials(req: { header: Headers }): string | null {
    const authHeader = req.header.get("authorization");
    if (!authHeader) {
        return null;
    }

    // Support "Bearer <token>" format
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    return match?.[1] ?? null;
}

/**
 * Create a generic authentication interceptor.
 *
 * Extracts credentials from request headers, verifies them using
 * a user-provided callback, and stores the resulting AuthContext
 * in AsyncLocalStorage for downstream access.
 *
 * A `ConnectError` thrown by `verifyCredentials` reaches the client unchanged (code and
 * message), so choose its text as public. Any other thrown value is replaced by
 * `Unauthenticated: Authentication failed`.
 *
 * @param options - Authentication options
 * @returns ConnectRPC interceptor
 * @throws {Error} When `skipMethods` contains `"*"`
 * @throws {RangeError} When `cache` has a `ttl` that is not finite and positive, or a `maxSize` that is not an integer of at least 1
 *
 * @example API key authentication
 * ```typescript
 * import { createAuthInterceptor } from '@connectum/auth';
 *
 * const auth = createAuthInterceptor({
 *   extractCredentials: (req) => req.header.get('x-api-key'),
 *   verifyCredentials: async (apiKey) => {
 *     const user = await db.findByApiKey(apiKey);
 *     if (!user) throw new Error('Invalid API key');
 *     return {
 *       subject: user.id,
 *       roles: user.roles,
 *       scopes: [],
 *       claims: {},
 *       type: 'api-key',
 *     };
 *   },
 * });
 * ```
 *
 * @example Bearer token with default extractor
 * ```typescript
 * const auth = createAuthInterceptor({
 *   verifyCredentials: async (token) => {
 *     const payload = await verifyToken(token);
 *     return {
 *       subject: payload.sub,
 *       roles: payload.roles ?? [],
 *       scopes: payload.scope?.split(' ') ?? [],
 *       claims: payload,
 *       type: 'jwt',
 *     };
 *   },
 * });
 * ```
 */
export function createAuthInterceptor(options: AuthInterceptorOptions): Interceptor {
    const { extractCredentials = defaultExtractCredentials, verifyCredentials, skipMethods = [], propagateHeaders = false, cache: cacheOptions, propagatedClaims } = options;

    assertNoCatchAllSkip(skipMethods);

    const cache = cacheOptions ? new LruCache<AuthContext>(cacheOptions) : undefined;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Strip auth headers to prevent spoofing from external clients
        for (const headerName of Object.values(AUTH_HEADERS)) {
            req.header.delete(headerName);
        }

        // Skip specified methods
        if (matchesMethodPattern(serviceName, methodName, skipMethods)) {
            return await next(req);
        }

        // Extract credentials
        const credentials = await extractCredentials(req);
        if (!credentials) {
            throw new ConnectError("Missing credentials", Code.Unauthenticated);
        }

        // Check cache before verification
        const cached = cache?.get(credentials);
        if (cached && (!cached.expiresAt || cached.expiresAt.getTime() > Date.now())) {
            if (propagateHeaders) {
                propagateAuthHeaders(req.header, cached, propagatedClaims);
            }
            return await runWithAuthContext(copyAuthContext(cached), () => next(req));
        }

        // Verify credentials
        let authContext: AuthContext;
        try {
            authContext = await verifyCredentials(credentials);
        } catch (err) {
            if (err instanceof ConnectError) {
                throw err;
            }
            throw new ConnectError("Authentication failed", Code.Unauthenticated);
        }

        // A callback that breaks its contract (null from a failed lookup, `{}`) must not
        // authenticate the call; check before the result is propagated or cached.
        if (!isAuthContext(authContext)) {
            throw new ConnectError("Authentication failed", Code.Unauthenticated);
        }

        // Propagate auth context as headers if enabled. This runs BEFORE the cache write:
        // an identity that cannot be propagated (NUL/CR/LF) is rejected here and must never
        // be stored, otherwise every later request with the same credentials would hit it.
        if (propagateHeaders) {
            propagateAuthHeaders(req.header, authContext, propagatedClaims);
        }

        // Cache a private copy: this request keeps the verifier's own object, later requests get
        // their own copies of the stored one, so no handler can change what another request sees.
        cache?.set(credentials, copyAuthContext(authContext));

        // Run downstream with auth context in AsyncLocalStorage
        return await runWithAuthContext(authContext, () => next(req));
    };
}
