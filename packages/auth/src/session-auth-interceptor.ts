/**
 * Session-based authentication interceptor
 *
 * Convenience wrapper for session-based auth systems (e.g., better-auth).
 * Implements interceptor directly (not via createAuthInterceptor) to pass
 * full request headers to verifySession for cookie-based auth support.
 *
 * @module session-auth-interceptor
 */

import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { isAuthContext } from "./auth-context-check.ts";
import { LruCache } from "./cache.ts";
import { copyOrRefuse } from "./cached-identity.ts";
import { propagateAuthHeaders } from "./headers.ts";
import { assertNoCatchAllSkip, matchesMethodPattern } from "./method-match.ts";
import { runWithAuthContext } from "./run-with-auth-context.ts";
import type { AuthContext, SessionAuthInterceptorOptions } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/**
 * Default token extractor.
 * Extracts Bearer token from Authorization header.
 */
function defaultExtractToken(req: { header: Headers }): string | null {
    const authHeader = req.header.get("authorization");
    if (!authHeader) return null;
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    return match?.[1] ?? null;
}

/**
 * Create a session-based authentication interceptor.
 *
 * Two-step authentication:
 * 1. Extract token from request
 * 2. Verify session via user-provided callback (receives full headers for cookie support)
 * 3. Map session data to AuthContext via user-provided mapper
 *
 * A `ConnectError` thrown by `verifySession` or `mapSession` reaches the client unchanged
 * (code and message), so choose its text as public. Any other thrown value is replaced by
 * `Unauthenticated: Session verification failed` / `Session mapping failed`.
 *
 * @param options - Session auth configuration
 * @returns ConnectRPC interceptor
 * @throws {Error} When `skipMethods` contains `"*"`
 * @throws {RangeError} When `cache` has a `ttl` that is not finite and positive, or a `maxSize` that is not an integer of at least 1
 *
 * @example better-auth integration
 * ```typescript
 * import { createSessionAuthInterceptor } from '@connectum/auth';
 *
 * const sessionAuth = createSessionAuthInterceptor({
 *   verifySession: (token, headers) => auth.api.getSession({ headers }),
 *   mapSession: (s) => ({
 *     subject: s.user.id,
 *     name: s.user.name,
 *     roles: [],
 *     scopes: [],
 *     claims: s.user,
 *     type: 'session',
 *   }),
 *   cache: { ttl: 60_000 },
 * });
 * ```
 */
export function createSessionAuthInterceptor(options: SessionAuthInterceptorOptions): Interceptor {
    const { verifySession, mapSession, extractToken = defaultExtractToken, cache: cacheOptions, skipMethods = [], propagateHeaders = false, propagatedClaims } = options;

    assertNoCatchAllSkip(skipMethods);

    const cache = cacheOptions ? new LruCache<AuthContext>(cacheOptions) : undefined;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Strip auth headers to prevent spoofing
        for (const headerName of Object.values(AUTH_HEADERS)) {
            req.header.delete(headerName);
        }

        if (matchesMethodPattern(serviceName, methodName, skipMethods)) {
            return await next(req);
        }

        // Extract token
        const token = await extractToken(req);
        if (!token) {
            throw new ConnectError("Missing credentials", Code.Unauthenticated);
        }

        // Check cache
        const cached = cache?.get(token);
        if (cached && (!cached.expiresAt || cached.expiresAt.getTime() > Date.now())) {
            if (propagateHeaders) {
                propagateAuthHeaders(req.header, cached, propagatedClaims);
            }
            return await runWithAuthContext(copyOrRefuse(cached, "Session mapping failed"), () => next(req));
        }

        // Verify session — pass full headers for cookie-based auth
        let session: unknown;
        try {
            session = await verifySession(token, req.header);
        } catch (err) {
            if (err instanceof ConnectError) throw err;
            throw new ConnectError("Session verification failed", Code.Unauthenticated);
        }

        // Map session to AuthContext
        let authContext: AuthContext;
        try {
            authContext = await mapSession(session);
        } catch (err) {
            if (err instanceof ConnectError) throw err;
            throw new ConnectError("Session mapping failed", Code.Unauthenticated);
        }

        // A mapper that breaks its contract (null from a failed lookup, `{}`) must not
        // authenticate the call; check before the result is propagated or cached.
        if (!isAuthContext(authContext)) {
            throw new ConnectError("Session mapping failed", Code.Unauthenticated);
        }

        // Propagate before caching: an identity that cannot be written into headers
        // (NUL/CR/LF) is rejected here and must never reach the cache.
        if (propagateHeaders) {
            propagateAuthHeaders(req.header, authContext, propagatedClaims);
        }

        // Cache a private copy: this request keeps the mapper's own object, later requests get
        // their own copies of the stored one, so no handler can change what another request sees.
        // The copy reads properties the shape check did not look at, so a failure here is an
        // identity that cannot be used, not a server error; nothing is stored in that case.
        if (cache) {
            cache.set(token, copyOrRefuse(authContext, "Session mapping failed"));
        }

        return await runWithAuthContext(authContext, () => next(req));
    };
}
