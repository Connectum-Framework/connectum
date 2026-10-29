/**
 * Retry middleware for event processing.
 *
 * Retries failed event handlers with configurable backoff strategy.
 * Integrates with the middleware pipeline.
 *
 * @module middleware/retry
 */

import { NonRetryableError, RetryableError } from "../errors.ts";
import { assertNumberOption, describeValue, MAX_TIMER_DELAY_MS } from "../optionValidation.ts";
import type { EventContext, EventMiddleware, RetryOptions } from "../types.ts";

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
    }

    return Math.min(delay, options.maxDelay);
}

const BACKOFF_STRATEGIES: readonly string[] = ["exponential", "linear", "fixed"];

/**
 * Refuse delay settings that would make the pause between attempts something other than the
 * configured one: a non-finite or negative delay, a delay above the longest timer (replaced by 1 ms
 * with a warning), a `multiplier` below 1, and a strategy name that is not one of the three
 * (which used to behave as `fixed`).
 */
function assertRetryTiming(options: { readonly backoff: unknown; readonly initialDelay: unknown; readonly maxDelay: unknown; readonly multiplier: unknown }): void {
    const owner = "retryMiddleware";
    if (typeof options.backoff !== "string") {
        throw new TypeError(`${owner}: backoff must be one of "exponential", "linear" or "fixed", got ${describeValue(options.backoff)}`);
    }
    if (!BACKOFF_STRATEGIES.includes(options.backoff)) {
        throw new RangeError(`${owner}: backoff must be one of "exponential", "linear" or "fixed", got ${describeValue(options.backoff)}`);
    }
    assertNumberOption({
        owner,
        name: "initialDelay",
        value: options.initialDelay,
        min: 0,
        max: MAX_TIMER_DELAY_MS,
        allowed: `a finite number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS}`,
    });
    assertNumberOption({
        owner,
        name: "maxDelay",
        value: options.maxDelay,
        min: 1,
        max: MAX_TIMER_DELAY_MS,
        allowed: `a finite number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}`,
    });
    assertNumberOption({ owner, name: "multiplier", value: options.multiplier, min: 1, max: Number.MAX_VALUE, allowed: "a finite number of at least 1" });
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
 * Wait `delay` ms or until `signal` aborts. Resolves `true` when the delay elapsed and `false`
 * when the abort ended it; it never rejects, so the caller decides what an abort means.
 */
function sleepUnlessAborted(delay: number, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        if (signal.aborted) {
            resolve(false);
            return;
        }
        const onAbort = (): void => {
            globalThis.clearTimeout(timer);
            resolve(false);
        };
        const timer = globalThis.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(true);
        }, delay);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * The per-event time limit (`AbortSignal.timeout`) ends with a `TimeoutError`. Any other abort
 * reason comes from the shutdown signal or from the drain abort of `EventBus.stop()`.
 */
function isTimeoutReason(reason: unknown): boolean {
    return reason instanceof Error && reason.name === "TimeoutError";
}

/**
 * End the attempt loop because the signal aborted while the event still had retry budget.
 *
 * A stop is not a failure of the event: it is returned to the broker (`nack(true)`) so that it is
 * handled again, and it does not reach the dead-letter middleware as an "error". Running out of the
 * per-event time is a failure and is thrown. A failing `nack` is dropped: the event stays
 * unacknowledged and the broker delivers it again by its own redelivery timeout, as for an
 * abandoned handler; throwing would only make the dead-letter middleware publish it.
 */
async function endOnAbort(ctx: EventContext): Promise<void> {
    const reason: unknown = ctx.signal.reason;
    if (isTimeoutReason(reason)) {
        throw reason;
    }
    try {
        await ctx.nack(true);
    } catch {
        // see above
    }
}

/**
 * Create a retry middleware with configurable options.
 *
 * On handler failure, retries up to `maxRetries` times with
 * the configured backoff strategy. If all retries exhaust,
 * the error is re-thrown for the next middleware (e.g., DLQ).
 *
 * When `ctx.signal` aborts while the event waits for its next attempt, the outcome depends on the
 * reason. A stop (the server's shutdown signal, or the drain abort of `EventBus.stop()`) returns
 * the event to the broker with `ctx.nack(true)` and ends the middleware without an error, so the
 * dead-letter middleware does not see it. Because the retry budget is not carried over, the broker
 * delivers the event again with a fresh budget; whether it does, and after what delay, is up to
 * the broker. The per-event `handlerTimeout` (a `TimeoutError`) is a failure and is thrown.
 */
export function retryMiddleware(options?: RetryOptions): EventMiddleware {
    // Only an omitted value takes the default: an explicit `null` is a mistake and is refused below.
    const configuredMaxRetries: unknown = options?.maxRetries;
    const maxRetries = configuredMaxRetries === undefined ? DEFAULT_MAX_RETRIES : configuredMaxRetries;
    requireMaxRetries(maxRetries);
    // As for maxRetries, only an omitted value takes the default; an explicit null is refused.
    const backoff: unknown = options?.backoff === undefined ? "exponential" : options.backoff;
    const initialDelay: unknown = options?.initialDelay === undefined ? DEFAULT_INITIAL_DELAY : options.initialDelay;
    const maxDelay: unknown = options?.maxDelay === undefined ? DEFAULT_MAX_DELAY : options.maxDelay;
    const multiplier: unknown = options?.multiplier === undefined ? DEFAULT_MULTIPLIER : options.multiplier;
    assertRetryTiming({ backoff, initialDelay, maxDelay, multiplier });
    const timing = { backoff, initialDelay, maxDelay, multiplier } as Required<Pick<RetryOptions, "backoff" | "initialDelay" | "maxDelay" | "multiplier">>;
    const retryableErrors = options?.retryableErrors;

    return async (event, ctx, next) => {
        let lastError: unknown;
        const baseAttempt = event.attempt;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            // Bail out before re-entering handler if shutdown requested
            if (attempt > 1 && ctx.signal.aborted) {
                return endOnAbort(ctx);
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
                const delay = calculateDelay(timing, attempt);
                if (!(await sleepUnlessAborted(delay, ctx.signal))) {
                    return endOnAbort(ctx);
                }
            }
        }

        throw lastError;
    };
}
