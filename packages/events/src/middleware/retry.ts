/**
 * Retry middleware for event processing.
 *
 * Retries failed event handlers with configurable backoff strategy.
 * Integrates with the middleware pipeline.
 *
 * @module middleware/retry
 */

import type { EventMiddleware, RetryOptions } from "../types.ts";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_MULTIPLIER = 2;

/**
 * Calculate delay for a given attempt based on backoff strategy.
 */
function calculateDelay(options: Required<Pick<RetryOptions, "backoff" | "initialDelay" | "maxDelay" | "multiplier">>, attempt: number): number {
    let delay: number;

    switch (options.backoff) {
        case "exponential":
            delay = options.initialDelay * options.multiplier ** (attempt - 1);
            break;
        case "linear":
            delay = options.initialDelay * attempt;
            break;
        case "fixed":
            delay = options.initialDelay;
            break;
        default:
            delay = options.initialDelay;
    }

    return Math.min(delay, options.maxDelay);
}

/**
 * Create a retry middleware with configurable options.
 *
 * On handler failure, retries up to `maxRetries` times with
 * the configured backoff strategy. If all retries exhaust,
 * the error is re-thrown for the next middleware (e.g., DLQ).
 */
export function retryMiddleware(options?: RetryOptions): EventMiddleware {
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoff = options?.backoff ?? "exponential";
    const initialDelay = options?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    const maxDelay = options?.maxDelay ?? DEFAULT_MAX_DELAY;
    const multiplier = options?.multiplier ?? DEFAULT_MULTIPLIER;
    const retryableErrors = options?.retryableErrors;

    return async (event, ctx, next) => {
        let lastError: unknown;
        const baseAttempt = event.attempt;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                // Propagate attempt number to inner middleware/handler
                if (attempt > 1) {
                    (event as { attempt: number }).attempt = baseAttempt + attempt - 1;
                }
                await next();
                return;
            } catch (error) {
                lastError = error;

                // Check if error is retryable
                if (retryableErrors && !retryableErrors(error)) {
                    throw error;
                }

                // Last attempt -- don't retry
                if (attempt > maxRetries) {
                    throw error;
                }

                // Honor ctx.signal -- abort retries if signal is aborted
                if (ctx.signal.aborted) {
                    throw lastError;
                }

                // Wait before retry with abort-aware sleep
                const delay = calculateDelay({ backoff, initialDelay, maxDelay, multiplier }, attempt);
                await new Promise<void>((resolve, reject) => {
                    const timer = globalThis.setTimeout(resolve, delay);
                    const onAbort = () => {
                        globalThis.clearTimeout(timer);
                        reject(ctx.signal.reason);
                    };
                    if (ctx.signal.aborted) {
                        globalThis.clearTimeout(timer);
                        reject(ctx.signal.reason);
                        return;
                    }
                    ctx.signal.addEventListener("abort", onAbort, { once: true });
                });
            }
        }

        throw lastError;
    };
}
