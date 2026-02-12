/**
 * Default interceptor chain factory
 *
 * Creates the production-ready interceptor chain with resilience patterns.
 * The interceptor order is fixed:
 * errorHandler → timeout → bulkhead → circuitBreaker → retry → fallback → validation → serializer.
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
 * All interceptors are enabled by default except fallback
 * (which requires a handler function).
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
     * @default true (30s)
     */
    timeout?: boolean | TimeoutOptions;

    /**
     * Bulkhead interceptor.
     * Limits concurrent requests to prevent resource exhaustion.
     * @default true (10/10)
     */
    bulkhead?: boolean | BulkheadOptions;

    /**
     * Circuit breaker interceptor.
     * Prevents cascading failures by breaking circuit on consecutive errors.
     * @default true (5 failures)
     */
    circuitBreaker?: boolean | CircuitBreakerOptions;

    /**
     * Retry interceptor.
     * Retries transient failures with exponential backoff.
     * @default true (3 retries)
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
     * @default true
     */
    serializer?: boolean | SerializerOptions;
}

/**
 * Creates the default interceptor chain with the specified configuration.
 *
 * The interceptor order is fixed and intentional:
 * 1. **errorHandler** - Catch-all error normalization (outermost, must be first)
 * 2. **timeout** - Enforce deadline before any processing
 * 3. **bulkhead** - Limit concurrency
 * 4. **circuitBreaker** - Prevent cascading failures
 * 5. **retry** - Retry transient failures (exponential backoff)
 * 6. **fallback** - Graceful degradation (DISABLED by default)
 * 7. **validation** - @connectrpc/validate (createValidateInterceptor)
 * 8. **serializer** - JSON serialization (innermost)
 *
 * @param options - Configuration for each interceptor
 * @returns Array of configured interceptors in the correct order
 *
 * @example
 * ```typescript
 * // All defaults (fallback disabled)
 * const interceptors = createDefaultInterceptors();
 *
 * // Disable retry, custom timeout
 * const interceptors = createDefaultInterceptors({
 *   retry: false,
 *   timeout: { duration: 10000 },
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

    // 2. Timeout
    if (options.timeout !== false) {
        const opts = typeof options.timeout === "object" ? options.timeout : {};
        interceptors.push(createTimeoutInterceptor(opts));
    }

    // 3. Bulkhead
    if (options.bulkhead !== false) {
        const opts = typeof options.bulkhead === "object" ? options.bulkhead : {};
        interceptors.push(createBulkheadInterceptor(opts));
    }

    // 4. Circuit breaker
    if (options.circuitBreaker !== false) {
        const opts = typeof options.circuitBreaker === "object" ? options.circuitBreaker : {};
        interceptors.push(createCircuitBreakerInterceptor(opts));
    }

    // 5. Retry
    if (options.retry !== false) {
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

    // 8. Serializer
    if (options.serializer !== false) {
        const opts = typeof options.serializer === "object" ? options.serializer : {};
        interceptors.push(createSerializerInterceptor(opts));
    }

    return interceptors;
}
