/**
 * @connectum/auth
 *
 * Authentication and authorization interceptors for Connectum.
 *
 * Provides five interceptor factories:
 * - createAuthInterceptor() — generic, pluggable authentication
 * - createJwtAuthInterceptor() — JWT convenience with jose
 * - createGatewayAuthInterceptor() — gateway-injected headers
 * - createSessionAuthInterceptor() — session-based auth (better-auth, etc.)
 * - createAuthzInterceptor() — declarative rules-based authorization
 *
 * Plus context propagation via AsyncLocalStorage and request headers.
 *
 * @module @connectum/auth
 */

// Interceptor factories
export { createAuthInterceptor } from "./auth-interceptor.ts";
export { createAuthzInterceptor } from "./authz-interceptor.ts";
// Cache
export { LruCache } from "./cache.ts";
// Context management
export { authContextStorage, getAuthContext, requireAuthContext } from "./context.ts";
export type { AuthzDeniedDetails } from "./errors.ts";
export { AuthzDeniedError } from "./errors.ts";
export { createGatewayAuthInterceptor } from "./gateway-auth-interceptor.ts";
// Header utilities
export { parseAuthHeaders, setAuthHeaders } from "./headers.ts";
export { createJwtAuthInterceptor } from "./jwt-auth-interceptor.ts";
// Method pattern matching
export { matchesMethodPattern } from "./method-match.ts";
export { createSessionAuthInterceptor } from "./session-auth-interceptor.ts";

// Types and constants
export type {
    AuthContext,
    AuthInterceptorOptions,
    AuthzInterceptorOptions,
    AuthzRule,
    CacheOptions,
    GatewayAuthInterceptorOptions,
    GatewayHeaderMapping,
    InterceptorFactory,
    JwtAuthInterceptorOptions,
    SessionAuthInterceptorOptions,
} from "./types.ts";

export { AUTH_HEADERS, AuthzEffect } from "./types.ts";
