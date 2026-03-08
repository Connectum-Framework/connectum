/**
 * Typed error classes for event processing control flow.
 *
 * Use NonRetryableError to skip retry middleware entirely.
 * Use RetryableError to force retry regardless of the retryableErrors predicate.
 *
 * Both use Symbol.for() branding for cross-realm compatibility.
 *
 * @module errors
 */

const NON_RETRYABLE = Symbol.for("@connectum/events.NonRetryableError");
const RETRYABLE = Symbol.for("@connectum/events.RetryableError");

/**
 * Error that should never be retried.
 *
 * When thrown inside an event handler, the retry middleware
 * skips all retries and re-throws immediately — regardless
 * of the `retryableErrors` predicate.
 *
 * @example
 * ```typescript
 * throw new NonRetryableError("Invalid payload", { cause: validationError });
 * ```
 */
export class NonRetryableError extends Error {
    readonly [NON_RETRYABLE] = true;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "NonRetryableError";
    }

    /**
     * Check if an error is branded as non-retryable.
     * Works across realms (Symbol.for is global).
     */
    static isNonRetryable(error: unknown): error is { [NON_RETRYABLE]: true } {
        return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[NON_RETRYABLE] === true;
    }
}

/**
 * Error that should always be retried.
 *
 * When thrown inside an event handler, the retry middleware
 * retries the handler — even if the `retryableErrors` predicate
 * would otherwise reject it.
 *
 * @example
 * ```typescript
 * throw new RetryableError("Temporary DB connection lost", { cause: dbError });
 * ```
 */
export class RetryableError extends Error {
    readonly [RETRYABLE] = true;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "RetryableError";
    }

    /**
     * Check if an error is branded as retryable.
     * Works across realms (Symbol.for is global).
     */
    static isRetryable(error: unknown): error is { [RETRYABLE]: true } {
        return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[RETRYABLE] === true;
    }
}
