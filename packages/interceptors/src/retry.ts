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
import { MAX_TIMER_MS, requireBoolean, requireConnectCodes, requireFiniteNumber, requireInteger, requireOptionsObject } from "./validate.ts";

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
 * The delay between attempts follows cockatiel's `ExponentialBackoff` with its
 * default decorrelated-jitter generator, scaled by `initialDelay` and capped at
 * `maxDelay`. The delays are randomized, so exact values and multipliers are not
 * guaranteed.
 *
 * Use retries only for idempotent operations. Streaming is skipped by default;
 * opting in retries opening failures, not errors while consuming an opened stream.
 *
 * `maxRetries` must be a finite number of at least 0 (fractions allowed);
 * `initialDelay` and `maxDelay` must be integers from 0 to 2147483647
 * milliseconds. Anything else throws at construction (`TypeError` for a
 * non-number, `RangeError` otherwise).
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
    requireOptionsObject({ caller: "createRetryInterceptor", value: options });
    const { maxRetries = 3, initialDelay = 200, maxDelay = 5000, skipStreaming = true, retryableCodes = [Code.Unavailable, Code.ResourceExhausted] } = options;

    // Validate options
    requireBoolean({ caller: "createRetryInterceptor", option: "skipStreaming", value: skipStreaming });
    requireConnectCodes({ caller: "createRetryInterceptor", option: "retryableCodes", value: retryableCodes });
    // A fractional budget stays valid: it is compared with the number of retries made.
    requireFiniteNumber({ caller: "createRetryInterceptor", option: "maxRetries", value: maxRetries, min: 0 });
    requireInteger({ caller: "createRetryInterceptor", option: "initialDelay", value: initialDelay, min: 0, max: MAX_TIMER_MS, unit: "milliseconds" });
    requireInteger({ caller: "createRetryInterceptor", option: "maxDelay", value: maxDelay, min: 0, max: MAX_TIMER_MS, unit: "milliseconds" });

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
