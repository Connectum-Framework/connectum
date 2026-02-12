/**
 * Timeout interceptor
 *
 * Prevents requests from hanging indefinitely.
 *
 * @module timeout
 */

import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { TaskCancelledError, TimeoutStrategy, timeout } from "cockatiel";
import type { TimeoutOptions } from "./types.ts";

/**
 * Create timeout interceptor
 *
 * Prevents requests from hanging indefinitely by enforcing a timeout.
 * Requests that exceed the timeout are cancelled and throw DeadlineExceeded error.
 *
 * @param options - Timeout options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createTimeoutInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createTimeoutInterceptor({
 *       duration: 30000,      // 30 second timeout
 *       skipStreaming: true,  // Skip streaming calls
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
 * import { createTimeoutInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createTimeoutInterceptor({ duration: 10000 }),
 *   ],
 * });
 * ```
 */
export function createTimeoutInterceptor(options: TimeoutOptions = {}): Interceptor {
    const { duration = 30000, skipStreaming = true } = options;

    // Validate options
    if (duration <= 0 || !Number.isFinite(duration)) {
        throw new Error("duration must be a positive finite number");
    }

    // Create timeout policy with Aggressive strategy
    const policy = timeout(duration, TimeoutStrategy.Aggressive);

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        try {
            // Execute with timeout protection
            return await policy.execute(() => next(req));
        } catch (err) {
            // Convert TimeoutError to ConnectError
            if (err instanceof TaskCancelledError) {
                throw new ConnectError(`Request timeout after ${duration}ms`, Code.DeadlineExceeded);
            }

            // Re-throw other errors
            throw err;
        }
    };
}
