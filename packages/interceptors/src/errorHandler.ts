/**
 * Error handler interceptor
 *
 * Transforms errors into ConnectError with proper error codes.
 *
 * @module errorHandler
 */

import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import type { ErrorHandlerOptions } from "./types.ts";

/**
 * Create error handler interceptor
 *
 * Catches all errors and transforms them into ConnectError instances
 * with proper error codes. Logs errors in development mode.
 *
 * IMPORTANT: This interceptor should be FIRST in the chain to catch all errors.
 *
 * @param options - Error handler options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createErrorHandlerInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createErrorHandlerInterceptor({
 *       logErrors: true,
 *       includeStackTrace: process.env.NODE_ENV !== 'production',
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
 * import { createErrorHandlerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createErrorHandlerInterceptor({ logErrors: true }),
 *   ],
 * });
 * ```
 */
export function createErrorHandlerInterceptor(options: ErrorHandlerOptions = {}): Interceptor {
    const { logErrors = process.env.NODE_ENV !== "production", includeStackTrace = process.env.NODE_ENV !== "production" } = options;

    return (next) => async (req) => {
        try {
            return await next(req);
        } catch (err) {
            // Log original error in development
            if (logErrors) {
                console.error("Interceptor caught error:", err);
            }

            // Transform to ConnectError
            const errWithCode = err as { code?: unknown };
            const code = typeof errWithCode?.code === "number" ? errWithCode.code : Code.Internal;

            const error = ConnectError.from(err, code);

            // Log transformed error in development
            if (logErrors) {
                console.error("Transformed ConnectError:", error);

                if (includeStackTrace && error.stack) {
                    console.error("Stack trace:", error.stack);
                }
            }

            throw error;
        }
    };
}
