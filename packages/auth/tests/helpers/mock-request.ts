/**
 * Shared test helpers for building chained ConnectRPC interceptor handlers.
 *
 * Generic mock factories (createMockRequest, createMockNext) have been
 * migrated to `@connectum/testing`. This file retains only auth-specific
 * composition utilities.
 */

/**
 * Build a chained auth -> authz interceptor handler for integration tests.
 *
 * Composes an authentication interceptor with an authorization interceptor,
 * creating a single handler function that processes requests through both.
 *
 * @param authInterceptor - The authentication interceptor (e.g., JWT auth).
 * @param authzInterceptor - The authorization interceptor (e.g., rule-based or proto-based).
 * @param next - The final handler to call after both interceptors pass.
 * @returns A composed handler function.
 */
export function buildChainedHandler(authInterceptor: (next: any) => any, authzInterceptor: (next: any) => any, next: any) {
    return authInterceptor(authzInterceptor(next as any) as any);
}
