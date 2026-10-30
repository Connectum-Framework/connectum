/**
 * Default interceptor chain factory
 *
 * Creates the interceptor chain in a fixed order:
 * errorHandler → timeout → bulkhead → circuitBreaker → retry → validation → fallback → serializer.
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
import type { DefaultOptionKind } from "./validate.ts";
import { requireDefaultOption, requireKnownKeys, requireOptionsObject } from "./validate.ts";

/**
 * Configuration options for the default interceptor chain.
 *
 * Except for fallback and validation, each interceptor can be:
 * - `false` to disable it entirely
 * - `true` to enable with default options
 * - An options object to enable with custom configuration
 *
 * Fallback requires an options object with a handler: `false` (or omitting it)
 * leaves it disabled and `true` is refused, because there is no default handler.
 * Validation accepts only a boolean and is enabled unless `false`.
 *
 * Any other value for a key (`null`, a number, a string, an array, a function) is
 * refused with a `TypeError` naming the key: a value that is not understood must
 * not silently disable an interceptor. A key that is not listed here, such as the
 * mistyped `timout`, is refused the same way, with the known keys in the message;
 * the logger and the method filter are not part of this chain, so create them
 * with their own factories. An argument that is not an object (`null`, for
 * example) is refused too. The numeric options inside an options
 * object are validated by their factories; see each options type for its range.
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
     * Pass an options object with a handler to enable it. `true` is refused
     * with a `TypeError`: a fallback without an application-specific handler
     * would silently do nothing.
     * @default false
     */
    fallback?: false | FallbackOptions;

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
 * Which shape each key accepts. Checked for every key before any interceptor is
 * built, so a bad value fails the whole call instead of silently disabling one
 * interceptor.
 */
const OPTION_KINDS: ReadonlyArray<readonly [keyof DefaultInterceptorOptions, DefaultOptionKind]> = [
    ["errorHandler", "toggle"],
    ["timeout", "toggle"],
    ["bulkhead", "toggle"],
    ["circuitBreaker", "toggle"],
    ["retry", "toggle"],
    ["fallback", "fallback"],
    ["validation", "boolean"],
    ["serializer", "toggle"],
];

/**
 * Pick the options object out of a value already accepted by
 * {@link requireDefaultOption}: an object is the options, `true` and
 * `undefined` mean "defaults". `null` and arrays cannot reach this point.
 */
function optionsOf<T extends object>(value: boolean | T | undefined): T | undefined {
    return typeof value === "object" ? value : undefined;
}

/**
 * Creates the default interceptor chain with the specified configuration.
 *
 * The interceptor order is fixed and intentional:
 * 1. **errorHandler** - Normalize rejections from downstream `next(req)` (outermost; enabled by default)
 * 2. **timeout** - Enforce deadline before any processing (OPT-IN)
 * 3. **bulkhead** - Limit concurrency (OPT-IN)
 * 4. **circuitBreaker** - Prevent cascading failures (OPT-IN; wraps retry — an
 *    ultimate failure counts once, regardless of the number of retry attempts)
 * 5. **retry** - Retry transient failures with exponential backoff (OPT-IN)
 * 6. **validation** - @connectrpc/validate (enabled by default; outside the fallback, so a
 *    rejected request is never answered by the fallback value)
 * 7. **fallback** - Graceful degradation (OPT-IN, requires handler)
 * 8. **serializer** - JSON serialization (innermost, OPT-IN)
 *
 * Resilience interceptors (2-5) are opt-in by design: the recommended path
 * must not silently alter request behavior.
 *
 * @param options - Configuration for each interceptor
 * @returns Array of configured interceptors in the correct order
 * @throws TypeError if a key holds a value its shape does not allow (see {@link DefaultInterceptorOptions})
 * @throws RangeError if a numeric option inside an options object is out of range
 *
 * @example
 * ```typescript
 * import { createDefaultInterceptors } from '@connectum/interceptors';
 *
 * // Defaults: errorHandler + validation only
 * const defaults = createDefaultInterceptors();
 *
 * // Explicitly enable resilience where needed
 * const withResilience = createDefaultInterceptors({
 *   timeout: { duration: 10000 },
 *   bulkhead: true,
 *   retry: { maxRetries: 3 },
 * });
 *
 * // Enable fallback with handler
 * const withFallback = createDefaultInterceptors({
 *   // A plain object with the fields of the method's response message, or a message made with create(ResponseSchema, ...)
 *   fallback: { handler: () => ({ items: [] }) },
 * });
 *
 * // No interceptors: omit `interceptors` option in createServer()
 * // or pass `interceptors: []`
 * ```
 */
export function createDefaultInterceptors(options: DefaultInterceptorOptions = {}): Interceptor[] {
    requireOptionsObject({ caller: "createDefaultInterceptors", value: options });
    // A key outside the list would otherwise be ignored: `{ timout: ... }` asks for a timeout and gets none.
    requireKnownKeys({ caller: "createDefaultInterceptors", value: options, known: OPTION_KINDS.map(([option]) => option) });

    for (const [option, kind] of OPTION_KINDS) {
        requireDefaultOption({ option, value: options[option], kind });
    }

    const interceptors: Interceptor[] = [];

    // 1. Error handler (must be first!)
    if (options.errorHandler !== false) {
        interceptors.push(createErrorHandlerInterceptor(optionsOf(options.errorHandler) ?? {}));
    }

    // 2. Timeout (opt-in: no hidden behavioral logic)
    if (options.timeout !== undefined && options.timeout !== false) {
        interceptors.push(createTimeoutInterceptor(optionsOf(options.timeout) ?? {}));
    }

    // 3. Bulkhead (opt-in: no hidden behavioral logic)
    if (options.bulkhead !== undefined && options.bulkhead !== false) {
        interceptors.push(createBulkheadInterceptor(optionsOf(options.bulkhead) ?? {}));
    }

    // 4. Circuit breaker (opt-in: no hidden behavioral logic)
    if (options.circuitBreaker !== undefined && options.circuitBreaker !== false) {
        interceptors.push(createCircuitBreakerInterceptor(optionsOf(options.circuitBreaker) ?? {}));
    }

    // 5. Retry (opt-in: no hidden behavioral logic)
    if (options.retry !== undefined && options.retry !== false) {
        interceptors.push(createRetryInterceptor(optionsOf(options.retry) ?? {}));
    }

    // 6. Validation (@connectrpc/validate). It stands outside the fallback: a request that
    // breaks a rule is a client error, and the fallback value is for failed dependencies,
    // timeouts and bugs. Were validation inside the fallback, the rejection would be
    // replaced by the fallback value and reach the caller as a successful response.
    if (options.validation !== false) {
        interceptors.push(createValidateInterceptor());
    }

    // 7. Fallback (opt-in, disabled by default — requires handler)
    if (options.fallback !== undefined && options.fallback !== false) {
        interceptors.push(createFallbackInterceptor(options.fallback));
    }

    // 8. Serializer (opt-in, disabled by default)
    if (options.serializer !== undefined && options.serializer !== false) {
        interceptors.push(createSerializerInterceptor(optionsOf(options.serializer) ?? {}));
    }

    return interceptors;
}
