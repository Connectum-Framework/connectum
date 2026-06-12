/**
 * Default interceptor chain factory
 *
 * Creates the interceptor chain in a fixed order:
 * errorHandler → timeout → bulkhead → circuitBreaker → retry → fallback → validation → serializer.
 * Only errorHandler and validation are enabled by default; resilience
 * interceptors (timeout, bulkhead, circuitBreaker, retry) are opt-in —
 * no hidden behavioral logic.
 *
 * @module defaults
 */

import type { Interceptor } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { createBulkheadInterceptor } from "./bulkhead.ts";
import { createCircuitBreakerInterceptor } from "./circuit-breaker.ts";
import { createErrorHandlerInterceptor } from "./errorHandler.ts";
import { createFallbackInterceptor } from "./fallback.ts";
import { createRetryInterceptor } from "./retry.ts";
import { createSerializerInterceptor } from "./serializer.ts";
import { createTimeoutInterceptor } from "./timeout.ts";
import type { BulkheadOptions, CircuitBreakerOptions, ErrorHandlerOptions, FallbackOptions, RetryOptions, SerializerOptions, TimeoutOptions } from "./types.ts";

/**
 * Configuration options for the default interceptor chain.
 *
 * Each interceptor can be:
 * - `false` to disable it entirely
 * - `true` to enable with default options
 * - An options object to enable with custom configuration
 *
 * Only structural interceptors (errorHandler, validation) are enabled by
 * default. Behavioral resilience interceptors (timeout, bulkhead,
 * circuitBreaker, retry) are opt-in: implicitly enabled behavior-altering
 * logic is hidden logic, and hidden logic caused a confirmed production
 * incident (a server-side circuit breaker tripping on expected business
 * errors). Enable each one explicitly where you need it.
 */
export interface DefaultInterceptorOptions {
    /**
     * Error handler interceptor (first in chain).
     * Transforms errors into ConnectError with proper codes.
     * @default true
     */
    errorHandler?: boolean | ErrorHandlerOptions;

    /**
     * Timeout interceptor.
     * Enforces request deadline before any processing.
     * Opt-in: no hidden behavioral logic.
     * @default false
     */
    timeout?: boolean | TimeoutOptions;

    /**
     * Bulkhead interceptor.
     * Limits concurrent requests to prevent resource exhaustion.
     * Opt-in: no hidden behavioral logic.
     * @default false
     */
    bulkhead?: boolean | BulkheadOptions;

    /**
     * Circuit breaker interceptor.
     * Prevents cascading failures by breaking circuit on consecutive errors.
     * Opt-in: no hidden behavioral logic. Intended primarily for outbound
     * client transports — see the README before enabling it server-side.
     * @default false
     */
    circuitBreaker?: boolean | CircuitBreakerOptions;

    /**
     * Retry interceptor.
     * Retries transient failures with exponential backoff.
     * Opt-in: no hidden behavioral logic.
     * @default false
     */
    retry?: boolean | RetryOptions;

    /**
     * Fallback interceptor.
     * Provides graceful degradation when service fails.
     * Disabled by default — requires a handler function.
     * @default false
     */
    fallback?: boolean | FallbackOptions;

    /**
     * Validation interceptor.
     * Validates request messages using @connectrpc/validate.
     * @default true
     */
    validation?: boolean;

    /**
     * Serializer interceptor (last in chain).
     * Auto JSON serialization for ConnectRPC responses.
     * Disabled by default — enable explicitly when JSON output is needed.
     * @default false
     */
    serializer?: boolean | SerializerOptions;
}

/**
 * Creates the default interceptor chain with the specified configuration.
 *
 * The interceptor order is fixed and intentional:
 * 1. **errorHandler** - Catch-all error normalization (outermost, must be first; enabled by default)
 * 2. **timeout** - Enforce deadline before any processing (OPT-IN)
 * 3. **bulkhead** - Limit concurrency (OPT-IN)
 * 4. **circuitBreaker** - Prevent cascading failures (OPT-IN; wraps retry — one logical
 *    request increments the failure counter once, regardless of retry attempts)
 * 5. **retry** - Retry transient failures with exponential backoff (OPT-IN)
 * 6. **fallback** - Graceful degradation (OPT-IN, requires handler)
 * 7. **validation** - @connectrpc/validate (enabled by default)
 * 8. **serializer** - JSON serialization (innermost, OPT-IN)
 *
 * Resilience interceptors (2-5) are opt-in by design: the recommended path
 * must not silently alter request behavior.
 *
 * @param options - Configuration for each interceptor
 * @returns Array of configured interceptors in the correct order
 *
 * @example
 * ```typescript
 * // Defaults: errorHandler + validation only
 * const interceptors = createDefaultInterceptors();
 *
 * // Explicitly enable resilience where needed
 * const interceptors = createDefaultInterceptors({
 *   timeout: { duration: 10000 },
 *   bulkhead: true,
 *   retry: { maxAttempts: 3 },
 * });
 *
 * // Enable fallback with handler
 * const interceptors = createDefaultInterceptors({
 *   fallback: { handler: () => ({ data: [] }) },
 * });
 *
 * // No interceptors: omit `interceptors` option in createServer()
 * // or pass `interceptors: []`
 * ```
 */
export function createDefaultInterceptors(options: DefaultInterceptorOptions = {}): Interceptor[] {
    const interceptors: Interceptor[] = [];

    // 1. Error handler (must be first!)
    if (options.errorHandler !== false) {
        const opts = typeof options.errorHandler === "object" ? options.errorHandler : {};
        interceptors.push(createErrorHandlerInterceptor(opts));
    }

    // 2. Timeout (opt-in: no hidden behavioral logic)
    if (options.timeout === true || typeof options.timeout === "object") {
        const opts = typeof options.timeout === "object" ? options.timeout : {};
        interceptors.push(createTimeoutInterceptor(opts));
    }

    // 3. Bulkhead (opt-in: no hidden behavioral logic)
    if (options.bulkhead === true || typeof options.bulkhead === "object") {
        const opts = typeof options.bulkhead === "object" ? options.bulkhead : {};
        interceptors.push(createBulkheadInterceptor(opts));
    }

    // 4. Circuit breaker (opt-in: no hidden behavioral logic)
    if (options.circuitBreaker === true || typeof options.circuitBreaker === "object") {
        const opts = typeof options.circuitBreaker === "object" ? options.circuitBreaker : {};
        interceptors.push(createCircuitBreakerInterceptor(opts));
    }

    // 5. Retry (opt-in: no hidden behavioral logic)
    if (options.retry === true || typeof options.retry === "object") {
        const opts = typeof options.retry === "object" ? options.retry : {};
        interceptors.push(createRetryInterceptor(opts));
    }

    // 6. Fallback (opt-in, disabled by default — requires handler)
    if (typeof options.fallback === "object") {
        interceptors.push(createFallbackInterceptor(options.fallback));
    }

    // 7. Validation (@connectrpc/validate)
    if (options.validation !== false) {
        interceptors.push(createValidateInterceptor());
    }

    // 8. Serializer (opt-in, disabled by default)
    if (options.serializer === true || typeof options.serializer === "object") {
        const opts = typeof options.serializer === "object" ? options.serializer : {};
        interceptors.push(createSerializerInterceptor(opts));
    }

    return interceptors;
}
