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
import { authContextStorage } from "./context.ts";
import { setAuthHeaders } from "./headers.ts";
import type { AuthContext, AuthInterceptorOptions } from "./types.ts";

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
 * Check if a method should be skipped based on skip patterns.
 *
 * @param serviceName - Fully-qualified service name (e.g., "user.v1.UserService")
 * @param methodName - Method name (e.g., "GetUser")
 * @param skipMethods - Array of skip patterns
 * @returns true if the method should be skipped
 */
function shouldSkip(serviceName: string, methodName: string, skipMethods: string[]): boolean {
    if (skipMethods.length === 0) {
        return false;
    }

    const fullMethod = `${serviceName}/${methodName}`;

    for (const pattern of skipMethods) {
        if (pattern === "*") {
            return true;
        }
        if (pattern === fullMethod) {
            return true;
        }
        if (pattern.endsWith("/*")) {
            const servicePattern = pattern.slice(0, -2);
            if (serviceName === servicePattern) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Create a generic authentication interceptor.
 *
 * Extracts credentials from request headers, verifies them using
 * a user-provided callback, and stores the resulting AuthContext
 * in AsyncLocalStorage for downstream access.
 *
 * @param options - Authentication options
 * @returns ConnectRPC interceptor
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
    const { extractCredentials = defaultExtractCredentials, verifyCredentials, skipMethods = [], propagateHeaders = false } = options;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Skip specified methods
        if (shouldSkip(serviceName, methodName, skipMethods)) {
            return await next(req);
        }

        // Extract credentials
        const credentials = await extractCredentials(req);
        if (!credentials) {
            throw new ConnectError("Missing credentials", Code.Unauthenticated);
        }

        // Verify credentials
        let authContext: AuthContext;
        try {
            authContext = await verifyCredentials(credentials);
        } catch (err) {
            if (err instanceof ConnectError) {
                throw err;
            }
            throw new ConnectError(err instanceof Error ? err.message : "Authentication failed", Code.Unauthenticated);
        }

        // Propagate auth context as headers if enabled
        if (propagateHeaders) {
            setAuthHeaders(req.header, authContext);
        }

        // Run downstream with auth context in AsyncLocalStorage
        return await authContextStorage.run(authContext, () => next(req));
    };
}

export { shouldSkip };
