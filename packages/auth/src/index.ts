/**
 * @connectum/auth
 *
 * Authentication and authorization interceptors for Connectum.
 *
 * Provides three interceptor factories:
 * - createAuthInterceptor() — generic, pluggable authentication
 * - createJwtAuthInterceptor() — JWT convenience with jose
 * - createAuthzInterceptor() — declarative rules-based authorization
 *
 * Plus context propagation via AsyncLocalStorage and request headers.
 *
 * @module @connectum/auth
 */

// Interceptor factories
export { createAuthInterceptor } from "./auth-interceptor.ts";
export { createAuthzInterceptor } from "./authz-interceptor.ts";
// Context management
export { authContextStorage, getAuthContext, requireAuthContext } from "./context.ts";
// Header utilities
export { parseAuthHeaders, setAuthHeaders } from "./headers.ts";
export { createJwtAuthInterceptor } from "./jwt-auth-interceptor.ts";
export { createTrustedHeadersReader } from "./trusted-headers.ts";

// Types and constants
export type {
    AuthContext,
    AuthInterceptorOptions,
    AuthzInterceptorOptions,
    AuthzRule,
    InterceptorFactory,
    JwtAuthInterceptorOptions,
    TrustedHeadersReaderOptions,
} from "./types.ts";

export { AUTH_HEADERS, AuthzEffect } from "./types.ts";
