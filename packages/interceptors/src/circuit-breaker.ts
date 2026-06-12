/**
 * Circuit breaker interceptor
 *
 * Prevents cascading failures by breaking circuit when service fails repeatedly.
 *
 * @module circuit-breaker
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { BrokenCircuitError, ConsecutiveBreaker, circuitBreaker, handleWhen } from "cockatiel";
import type { CircuitBreakerOptions } from "./types.ts";

/**
 * Connect codes that count as circuit failures by default.
 *
 * Only infrastructure-level codes are listed: business codes
 * (invalid_argument, not_found, failed_precondition, already_exists, ...)
 * are expected responses of a healthy service and must never trip the
 * breaker. ResourceExhausted is included because, on an outbound call, it is
 * an honest "upstream degrading / stop sending" signal; exclude it via a
 * custom failurePredicate when the upstream uses it for per-client quotas.
 */
const INFRASTRUCTURE_CODES: ReadonlySet<Code> = new Set([Code.Unknown, Code.DeadlineExceeded, Code.Internal, Code.Unavailable, Code.DataLoss, Code.ResourceExhausted]);

/**
 * Default circuit-failure classification.
 *
 * A ConnectError counts as a failure only when its code is an infrastructure
 * code (Unknown, DeadlineExceeded, Internal, Unavailable, DataLoss,
 * ResourceExhausted). Any non-ConnectError thrown value counts as a failure:
 * unknown transport or runtime faults must still protect the upstream.
 *
 * Exported so custom predicates can compose with it — it is also passed as
 * the second argument to {@link CircuitBreakerOptions.failurePredicate}.
 */
export function defaultFailurePredicate(error: unknown): boolean {
    if (error instanceof ConnectError) {
        return INFRASTRUCTURE_CODES.has(error.code);
    }
    return true;
}

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
 * By default only infrastructure errors trip the breaker (see
 * {@link defaultFailurePredicate}); business codes like invalid_argument or
 * not_found never do. Customize via {@link CircuitBreakerOptions.failurePredicate}.
 *
 * The circuit breaker is an outbound/client-side pattern: it protects the
 * caller from a sick upstream and gives that upstream room to recover. On a
 * server's inbound stack it degenerates into error-rate load shedding —
 * prefer timeout + bulkhead for inbound protection.
 *
 * @param options - Circuit breaker options
 * @returns ConnectRPC interceptor
 *
 * @example Client-side usage with transport (recommended placement)
 * ```typescript
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createCircuitBreakerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createCircuitBreakerInterceptor({
 *       threshold: 5,           // Open after 5 consecutive failures
 *       halfOpenAfter: 30000,   // Try again after 30 seconds
 *     }),
 *   ],
 * });
 * ```
 *
 * @example Custom failure classification (compose with the default)
 * ```typescript
 * import { Code, ConnectError } from '@connectrpc/connect';
 *
 * createCircuitBreakerInterceptor({
 *   // Never trip on upstream per-client rate limits
 *   failurePredicate: (err, def) =>
 *     def(err) && !(err instanceof ConnectError && err.code === Code.ResourceExhausted),
 * });
 * ```
 */
export function createCircuitBreakerInterceptor(options: CircuitBreakerOptions = {}): Interceptor {
    const { threshold = 5, halfOpenAfter = 30000, skipStreaming = true, failurePredicate } = options;

    // Validate options
    if (threshold < 1 || !Number.isFinite(threshold)) {
        throw new Error("threshold must be a positive finite number");
    }

    if (halfOpenAfter < 0 || !Number.isFinite(halfOpenAfter)) {
        throw new Error("halfOpenAfter must be a non-negative finite number");
    }

    // Classification wrapper. The try/catch is mandatory, not defensive:
    // cockatiel calls the error filter without protection (Executor.invoke),
    // so an exception thrown from it propagates as an UNHANDLED error — in
    // half-open state that would close the circuit, inverting fail-closed.
    const isFailure = (error: unknown): boolean => {
        if (failurePredicate === undefined) {
            return defaultFailurePredicate(error);
        }
        try {
            return failurePredicate(error, defaultFailurePredicate);
        } catch (predicateError) {
            console.error("[circuit-breaker] failurePredicate threw — counting error as failure:", predicateError);
            return true;
        }
    };

    // Errors rejected by the predicate are "unhandled" for cockatiel: they do
    // not increment the breaker and, in half-open, close the circuit
    // ("Task failed successfully" path in CircuitBreakerPolicy.halfOpen).
    const breaker = circuitBreaker(handleWhen(isFailure), {
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
