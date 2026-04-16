/**
 * Client-side Bearer token interceptor
 *
 * Sets the Authorization header with a Bearer token on outgoing requests.
 * Supports both static tokens and async token factories for refresh flows.
 *
 * @module client-bearer-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import type { ClientBearerInterceptorOptions } from "./types.ts";

/**
 * Create a client interceptor that attaches a Bearer token to outgoing requests.
 *
 * The interceptor sets the `Authorization: Bearer <token>` header on every
 * outgoing request. If a token factory function is provided instead of a
 * static string, it is called before each request to support token refresh.
 *
 * @param options - Configuration with a static token or async token factory
 * @returns A ConnectRPC client Interceptor
 *
 * @example Static token
 * ```typescript
 * import { createClientBearerInterceptor } from '@connectum/auth';
 * import { createConnectTransport } from '@connectrpc/connect-node';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://localhost:5000',
 *     interceptors: [createClientBearerInterceptor({
 *         token: 'my-static-jwt-token',
 *     })],
 * });
 * ```
 *
 * @example Async token factory (refresh)
 * ```typescript
 * import { createClientBearerInterceptor } from '@connectum/auth';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://localhost:5000',
 *     interceptors: [createClientBearerInterceptor({
 *         token: async () => {
 *             const { accessToken } = await refreshTokenIfNeeded();
 *             return accessToken;
 *         },
 *     })],
 * });
 * ```
 */
export function createClientBearerInterceptor(options: ClientBearerInterceptorOptions): Interceptor {
    const { token } = options;

    return (next) => async (req) => {
        const resolvedToken = typeof token === "function" ? await token() : token;
        req.header.set("authorization", `Bearer ${resolvedToken}`);
        return await next(req);
    };
}
