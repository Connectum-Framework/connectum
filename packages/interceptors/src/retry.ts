/**
 * Retry interceptor
 *
 * Automatically retries failed unary RPC calls with exponential backoff.
 * Uses cockatiel for consistent resilience pattern implementation.
 *
 * @module retry
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { IBackoff, IBackoffFactory, IRetryBackoffContext } from "cockatiel";
import { ExponentialBackoff } from "cockatiel";
import type { RetryOptions } from "./types.ts";

/**
 * Create retry interceptor
 *
 * Automatically retries failed unary RPC calls with exponential backoff.
 * Only retries on configurable error codes (Unavailable and ResourceExhausted by default).
 * Cancellation interrupts backoff and prevents future attempts. An already
 * running handler is awaited so bulkheads continue to account for active work;
 * handlers and I/O must observe the signal to stop promptly. A cancelled attempt
 * cannot become a successful retry result when it completes later.
 *
 * Use retries only for idempotent operations. Streaming is skipped by default;
 * opting in retries opening failures, not errors while consuming an opened stream.
 *
 * @param options - Retry options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { Code } from '@connectrpc/connect';
 * import { createRetryInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
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

    const factory: IBackoffFactory<IRetryBackoffContext<unknown>> = new ExponentialBackoff({ initialDelay, maxDelay });

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        let backoff: IBackoff<IRetryBackoffContext<unknown>> | undefined;
        for (let retries = 0; ; retries++) {
            if (req.signal.aborted) {
                throw ConnectError.from(req.signal.reason, Code.Canceled);
            }

            try {
                // Do not race active work against cancellation: its enclosing
                // bulkhead must hold capacity until the handler really settles.
                const result = await next(req);
                if (req.signal.aborted) {
                    throw ConnectError.from(req.signal.reason, Code.Canceled);
                }
                return result;
            } catch (err) {
                if (req.signal.aborted) {
                    throw ConnectError.from(req.signal.reason, Code.Canceled);
                }
                if (!retryableCodes.includes(ConnectError.from(err).code) || retries >= maxRetries) {
                    throw err;
                }

                const context: IRetryBackoffContext<unknown> = { attempt: retries + 1, signal: req.signal, result: { error: err } };
                backoff = backoff ? backoff.next(context) : factory.next(context);
                if (req.signal.aborted) {
                    throw ConnectError.from(req.signal.reason, Code.Canceled);
                }
                try {
                    await delay(backoff.duration, undefined, { signal: req.signal, ref: true });
                } catch (delayError) {
                    if (req.signal.aborted) {
                        throw ConnectError.from(req.signal.reason, Code.Canceled);
                    }
                    throw delayError;
                }
            }
        }
    };
}
