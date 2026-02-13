/**
 * Circuit breaker interceptor
 *
 * Prevents cascading failures by breaking circuit when service fails repeatedly.
 *
 * @module circuit-breaker
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { BrokenCircuitError, ConsecutiveBreaker, circuitBreaker, handleAll } from "cockatiel";
import type { CircuitBreakerOptions } from "./types.ts";

/**
 * Create circuit breaker interceptor
 *
 * Prevents cascading failures by opening circuit after consecutive failures.
 * When circuit is open, requests fail immediately without calling the service.
 *
 * Circuit States:
 * - Closed (normal): Requests pass through
 * - Open (failing): Requests rejected immediately
 * - Half-Open (testing): Single request allowed to test recovery
 *
 * @param options - Circuit breaker options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createCircuitBreakerInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createCircuitBreakerInterceptor({
 *       threshold: 5,           // Open after 5 consecutive failures
 *       halfOpenAfter: 30000,   // Try again after 30 seconds
 *       skipStreaming: true,    // Skip streaming calls
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
 * import { createCircuitBreakerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createCircuitBreakerInterceptor({ threshold: 3 }),
 *   ],
 * });
 * ```
 */
export function createCircuitBreakerInterceptor(options: CircuitBreakerOptions = {}): Interceptor {
    const { threshold = 5, halfOpenAfter = 30000, skipStreaming = true } = options;

    // Validate options
    if (threshold < 1 || !Number.isFinite(threshold)) {
        throw new Error("threshold must be a positive finite number");
    }

    if (halfOpenAfter < 0 || !Number.isFinite(halfOpenAfter)) {
        throw new Error("halfOpenAfter must be a non-negative finite number");
    }

    // Create circuit breaker policy using handleAll and ConsecutiveBreaker
    const breaker = circuitBreaker(handleAll, {
        halfOpenAfter,
        breaker: new ConsecutiveBreaker(threshold),
    });

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        try {
            // Execute with circuit breaker protection
            return await breaker.execute(() => next(req));
        } catch (err) {
            // Convert BrokenCircuitError to ConnectError
            if (err instanceof BrokenCircuitError) {
                throw new ConnectError(`Circuit breaker is open (${threshold} consecutive failures)`, Code.Unavailable);
            }

            // Re-throw other errors
            throw err;
        }
    };
}
