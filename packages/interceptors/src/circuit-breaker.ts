/**
 * Circuit breaker interceptor
 *
 * Prevents cascading failures by breaking circuit when service fails repeatedly.
 *
 * @module circuit-breaker
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { BrokenCircuitError, CircuitState, ConsecutiveBreaker, circuitBreaker, handleWhen } from "cockatiel";
import type { CircuitBreakerOptions } from "./types.ts";
import { MAX_TIMER_MS, requireBoolean, requireFunction, requireInteger, requireOptionsObject } from "./validate.ts";

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
 * - Half-Open (testing): Single request allowed to test recovery. While that probe
 *   is in flight, every other call is rejected at once with the same
 *   `Unavailable` error as in the open state; none of them waits for the probe.
 *   A successful probe closes the circuit, a failed one opens it again.
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
 * Every call creates one breaker, and that single breaker counts the failures of
 * every request it covers (streaming calls are skipped by default) that passes
 * through the returned interceptor, whatever the service or method. Calls to different upstreams need one interceptor each.
 *
 * `threshold` must be an integer of at least 1 and `halfOpenAfter` an integer from
 * 0 to 2147483647 milliseconds; anything else throws at construction (`TypeError`
 * for a non-number, `RangeError` otherwise).
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
 *   httpVersion: '1.1',
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
    requireOptionsObject({ caller: "createCircuitBreakerInterceptor", value: options });
    const { threshold = 5, halfOpenAfter = 30000, skipStreaming = true, failurePredicate } = options;

    // Validate options
    requireInteger({ caller: "createCircuitBreakerInterceptor", option: "threshold", value: threshold, min: 1 });
    requireInteger({ caller: "createCircuitBreakerInterceptor", option: "halfOpenAfter", value: halfOpenAfter, min: 0, max: MAX_TIMER_MS, unit: "milliseconds" });
    requireBoolean({ caller: "createCircuitBreakerInterceptor", option: "skipStreaming", value: skipStreaming });
    if (failurePredicate !== undefined) {
        requireFunction({ caller: "createCircuitBreakerInterceptor", option: "failurePredicate", value: failurePredicate });
    }

    // Classification wrapper. The try/catch is mandatory, not defensive:
    // cockatiel invokes the error filter without guarding it (verified in the
    // policy executor through cockatiel v4), so an exception thrown from the
    // predicate propagates as an UNHANDLED error — in half-open state that
    // would close the circuit, inverting fail-closed.
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

    // Errors rejected by the predicate are "unhandled" for cockatiel: the
    // executor rethrows them, so they do not increment the breaker and, in
    // half-open, they take the success path and close the circuit.
    const breaker = circuitBreaker(handleWhen(isFailure), {
        halfOpenAfter,
        breaker: new ConsecutiveBreaker(threshold),
    });

    const openError = (): ConnectError => new ConnectError(`Circuit breaker is open (${threshold} consecutive failures)`, Code.Unavailable);

    // Whether the half-open probe is running. cockatiel makes every other caller
    // that arrives meanwhile wait for the probe's verdict and then run, so a slow
    // probe would hold them all and a healthy one would let them through together.
    // They are rejected at once instead: one probe decides, as documented.
    // Identified by a token of its own: a call that began while the circuit was still
    // closed can fail during a probe and open the circuit again, so a second probe may
    // start before the first probe's call has ended. The first one must not clear the
    // mark of the second when it ends.
    let currentProbe: object | undefined;

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        if (currentProbe !== undefined && breaker.state === CircuitState.HalfOpen) {
            throw openError();
        }

        // The call that starts its work while the policy is half-open is the probe.
        // Work starts synchronously inside execute(), so no other caller can slip in
        // between the policy's switch to half-open and this flag being set.
        const probe = {};
        try {
            // Execute with circuit breaker protection
            return await breaker.execute(() => {
                if (breaker.state === CircuitState.HalfOpen) {
                    currentProbe = probe;
                }
                return next(req);
            });
        } catch (err) {
            // Convert BrokenCircuitError to ConnectError
            if (err instanceof BrokenCircuitError) {
                throw openError();
            }

            // Re-throw other errors
            throw err;
        } finally {
            // Cleared only after the policy has recorded the verdict, so a caller
            // arriving in between sees either a half-open policy with a probe in
            // flight or the already decided state, never a gap.
            if (currentProbe === probe) {
                currentProbe = undefined;
            }
        }
    };
}
