/**
 * @connectum/interceptors
 *
 * Production-ready ConnectRPC interceptors with resilience patterns.
 *
 * Default chain (8 interceptors):
 * errorHandler → timeout → bulkhead → circuitBreaker → retry → fallback → validation → serializer
 *
 * @module @connectum/interceptors
 */

// Default interceptor chain factory
export { createDefaultInterceptors } from "./defaults.ts";
export type { DefaultInterceptorOptions } from "./defaults.ts";

// Interceptor factories
export { createErrorHandlerInterceptor } from "./errorHandler.ts";
export { createLoggerInterceptor } from "./logger.ts";
export { createSerializerInterceptor } from "./serializer.ts";
export { createRetryInterceptor } from "./retry.ts";
export { createCircuitBreakerInterceptor } from "./circuit-breaker.ts";
export { createTimeoutInterceptor } from "./timeout.ts";
export { createBulkheadInterceptor } from "./bulkhead.ts";
export { createFallbackInterceptor } from "./fallback.ts";

// Method filter interceptor
export { createMethodFilterInterceptor } from "./method-filter.ts";

// Types
export type {
    BulkheadOptions,
    CircuitBreakerOptions,
    ErrorHandlerOptions,
    FallbackOptions,
    InterceptorFactory,
    LoggerOptions,
    MethodFilterMap,
    RetryOptions,
    SerializerOptions,
    TimeoutOptions,
} from "./types.ts";
