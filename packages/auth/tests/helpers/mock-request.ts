/**
 * Shared test helpers for creating mock ConnectRPC requests.
 *
 * Provides factory functions for creating simple mock requests (without
 * proto descriptors) and building chained interceptor handlers.
 */

/**
 * Create a mock ConnectRPC request for testing interceptors.
 *
 * @param options - Optional overrides for service name, method name, and headers.
 * @returns A mock request object compatible with ConnectRPC interceptors.
 */
export function createMockRequest(options?: { serviceName?: string; methodName?: string; headers?: Headers }) {
    const serviceName = options?.serviceName ?? "test.v1.TestService";
    const methodName = options?.methodName ?? "TestMethod";
    const headers = options?.headers ?? new Headers();

    return {
        service: { typeName: serviceName },
        method: { name: methodName },
        header: headers,
        url: `http://localhost/${serviceName}/${methodName}`,
        stream: false,
        message: {},
    } as any;
}

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
