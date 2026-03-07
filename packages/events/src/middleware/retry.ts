/**
 * Retry middleware for event processing.
 *
 * Retries failed event handlers with configurable backoff strategy.
 * Integrates with the middleware pipeline.
 *
 * @module middleware/retry
 */

import { setTimeout } from "node:timers/promises";
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

    return async (_event, _ctx, next) => {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
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

                // Wait before retry
                const delay = calculateDelay({ backoff, initialDelay, maxDelay, multiplier }, attempt);
                await setTimeout(delay);
            }
        }

        throw lastError;
    };
}
