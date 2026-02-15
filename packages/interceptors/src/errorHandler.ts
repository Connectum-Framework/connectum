/**
 * Error handler interceptor
 *
 * Transforms errors into ConnectError with proper error codes.
 * Recognizes SanitizableError protocol for safe client-facing messages.
 *
 * @module errorHandler
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: workspace package import
import { isSanitizableError } from "@connectum/core";
import type { ErrorHandlerOptions } from "./types.ts";

/**
 * Create error handler interceptor
 *
 * Catches all errors and transforms them into ConnectError instances
 * with proper error codes. Recognizes SanitizableError for safe
 * client-facing messages while preserving server details for logging.
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
 *       onError: ({ error, code, serverDetails, stack }) => {
 *         logger.error('RPC error', { error: error.message, code, serverDetails, stack });
 *       },
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 */
export function createErrorHandlerInterceptor(options: ErrorHandlerOptions = {}): Interceptor {
    const { logErrors = process.env.NODE_ENV !== "production", includeStackTrace = process.env.NODE_ENV !== "production", onError } = options;

    return (next) => async (req) => {
        try {
            return await next(req);
        } catch (err) {
            // SanitizableError: preserve server details for logging, sanitize for client
            if (isSanitizableError(err)) {
                if (onError) {
                    const info: Parameters<NonNullable<ErrorHandlerOptions["onError"]>>[0] = {
                        error: err as Error,
                        code: err.code,
                        serverDetails: err.serverDetails,
                    };
                    const errStack = (err as Error).stack;
                    if (includeStackTrace && errStack) info.stack = errStack;
                    onError(info);
                } else if (logErrors) {
                    console.error("Interceptor caught error:", err);
                    console.error("Transformed ConnectError:", err.clientMessage);
                    if (includeStackTrace && (err as Error).stack) {
                        console.error("Stack trace:", (err as Error).stack);
                    }
                }
                throw new ConnectError(err.clientMessage, err.code);
            }

            // Non-sanitizable errors
            const errWithCode = err as { code?: unknown };
            const code = typeof errWithCode?.code === "number" ? errWithCode.code : Code.Internal;
            const error = ConnectError.from(err, code);

            if (onError) {
                const info: Parameters<NonNullable<ErrorHandlerOptions["onError"]>>[0] = {
                    error: error,
                    code,
                };
                if (includeStackTrace && error.stack) info.stack = error.stack;
                onError(info);
            } else if (logErrors) {
                console.error("Interceptor caught error:", err);
                console.error("Transformed ConnectError:", error);
                if (includeStackTrace && error.stack) {
                    console.error("Stack trace:", error.stack);
                }
            }

            throw error;
        }
    };
}
