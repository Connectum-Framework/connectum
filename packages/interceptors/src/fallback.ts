/**
 * Fallback interceptor
 *
 * Provides graceful degradation when service fails.
 *
 * @module fallback
 */

import type { Interceptor, UnaryResponse } from "@connectrpc/connect";
import type { FallbackOptions } from "./types.ts";

/**
 * Create fallback interceptor
 *
 * Provides fallback response when service fails, enabling graceful degradation.
 *
 * @param options - Fallback options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createFallbackInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createFallbackInterceptor({
 *       handler: (error) => {
 *         console.error('Service failed, returning cached data:', error);
 *         return { message: getCachedData() };
 *       },
 *       skipStreaming: true,
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 *
 * @example Client-side usage with transport
 * ```typescript
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createFallbackInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createFallbackInterceptor({
 *       handler: () => ({ data: [] }),
 *     }),
 *   ],
 * });
 * ```
 */
export function createFallbackInterceptor<T = unknown>(options: FallbackOptions<T>): Interceptor {
    const { handler, skipStreaming = true } = options;

    // Validate options
    if (typeof handler !== "function") {
        throw new Error("handler must be a function");
    }

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        try {
            // Execute normally
            return await next(req);
        } catch (err) {
            // Call fallback handler
            const fallbackValue = await handler(err as Error);

            return {
                stream: false,
                service: req.service,
                method: req.method,
                message: fallbackValue,
                header: new Headers(req.header),
                trailer: new Headers(),
            } as unknown as UnaryResponse;
        }
    };
}
