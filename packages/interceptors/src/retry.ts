/**
 * Retry interceptor
 *
 * Automatically retries failed unary RPC calls with exponential backoff.
 * Uses cockatiel for consistent resilience pattern implementation.
 *
 * @module retry
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { ExponentialBackoff, handleAll, retry } from "cockatiel";
import type { RetryOptions } from "./types.ts";

/**
 * Create retry interceptor
 *
 * Automatically retries failed unary RPC calls with exponential backoff.
 * Only retries on configurable error codes (Unavailable and ResourceExhausted by default).
 *
 * @param options - Retry options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createRetryInterceptor } from '@connectum/interceptors';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createRetryInterceptor({
 *       maxRetries: 3,
 *       initialDelay: 200,
 *       maxDelay: 5000,
 *       retryableCodes: [Code.Unavailable, Code.ResourceExhausted],
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 */
export function createRetryInterceptor(options: RetryOptions = {}): Interceptor {
    const { maxRetries = 3, initialDelay = 200, maxDelay = 5000, skipStreaming = true, retryableCodes = [Code.Unavailable, Code.ResourceExhausted] } = options;

    // Validate options
    if (maxRetries < 0 || !Number.isFinite(maxRetries)) {
        throw new Error("maxRetries must be a non-negative finite number");
    }

    if (initialDelay < 0 || !Number.isFinite(initialDelay)) {
        throw new Error("initialDelay must be a non-negative finite number");
    }

    if (maxDelay < 0 || !Number.isFinite(maxDelay)) {
        throw new Error("maxDelay must be a non-negative finite number");
    }

    // Create retry policy with exponential backoff using cockatiel
    const retryPolicy = retry(handleAll, {
        maxAttempts: maxRetries,
        backoff: new ExponentialBackoff({ initialDelay, maxDelay }),
    });

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        return await retryPolicy.execute(async ({ attempt }) => {
            try {
                return await next(req);
            } catch (err) {
                const connectErr = ConnectError.from(err);

                // Only retry on retryable error codes
                if (!retryableCodes.includes(connectErr.code)) {
                    throw err;
                }

                // On last attempt, throw the original error
                if (attempt >= maxRetries) {
                    throw err;
                }

                // Throw to trigger retry
                throw err;
            }
        });
    };
}
