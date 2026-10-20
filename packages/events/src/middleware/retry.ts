/**
 * Retry middleware for event processing.
 *
 * Retries failed event handlers with configurable backoff strategy.
 * Integrates with the middleware pipeline.
 *
 * @module middleware/retry
 */

import { NonRetryableError, RetryableError } from "../errors.ts";
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
 * Refuse a `maxRetries` the attempt loop cannot honour. A negative number or `NaN` would skip the
 * loop, so the handler would never run and `undefined` would reach the dead-letter middleware.
 */
function requireMaxRetries(value: unknown): asserts value is number {
    const message = `retryMiddleware: maxRetries must be an integer of at least 0, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(message);
    }
}

/**
 * Create a retry middleware with configurable options.
 *
 * On handler failure, retries up to `maxRetries` times with
 * the configured backoff strategy. If all retries exhaust,
 * the error is re-thrown for the next middleware (e.g., DLQ).
 */
export function retryMiddleware(options?: RetryOptions): EventMiddleware {
    // Only an omitted value takes the default: an explicit `null` is a mistake and is refused below.
    const configuredMaxRetries: unknown = options?.maxRetries;
    const maxRetries = configuredMaxRetries === undefined ? DEFAULT_MAX_RETRIES : configuredMaxRetries;
    requireMaxRetries(maxRetries);
    const backoff = options?.backoff ?? "exponential";
    const initialDelay = options?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    const maxDelay = options?.maxDelay ?? DEFAULT_MAX_DELAY;
    const multiplier = options?.multiplier ?? DEFAULT_MULTIPLIER;
    const retryableErrors = options?.retryableErrors;

    return async (event, ctx, next) => {
        let lastError: unknown;
        const baseAttempt = event.attempt;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            // Bail out before re-entering handler if shutdown requested
            if (attempt > 1 && ctx.signal.aborted) {
                throw ctx.signal.reason;
            }

            try {
                // Propagate attempt number to inner middleware/handler via shallow copy
                // passed through next() — avoids mutating the readonly RawEvent (C-1)
                if (attempt > 1) {
                    const retryEvent = { ...event, attempt: baseAttempt + attempt - 1 };
                    await next(retryEvent);
                } else {
                    await next();
                }
                return;
            } catch (error) {
                lastError = error;

                // Priority: NonRetryable brand > Retryable brand > predicate > retry all
                if (NonRetryableError.isNonRetryable(error)) {
                    throw error;
                }
                if (!RetryableError.isRetryable(error) && retryableErrors && !retryableErrors(error)) {
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
                    const onAbort = () => {
                        globalThis.clearTimeout(timer);
                        reject(ctx.signal.reason);
                    };
                    const timer = globalThis.setTimeout(() => {
                        ctx.signal.removeEventListener("abort", onAbort);
                        resolve();
                    }, delay);
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
