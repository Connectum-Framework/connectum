/**
 * @connectum/interceptors
 *
 * Production-ready ConnectRPC interceptors with resilience patterns.
 *
 * Default chain (8 interceptors):
 * errorHandler → timeout → bulkhead → circuitBreaker → retry → fallback → validation → serializer
 *
 * @module @connectum/interceptors
 * @mergeModuleWith <project>
 */

export { createBulkheadInterceptor } from "./bulkhead.ts";
export { createCircuitBreakerInterceptor } from "./circuit-breaker.ts";
export type { DefaultInterceptorOptions } from "./defaults.ts";
// Default interceptor chain factory
export { createDefaultInterceptors } from "./defaults.ts";
// Interceptor factories
export { createErrorHandlerInterceptor } from "./errorHandler.ts";
export { createFallbackInterceptor } from "./fallback.ts";
export { createLoggerInterceptor } from "./logger.ts";
// Method filter interceptor
export { createMethodFilterInterceptor } from "./method-filter.ts";
export { createRetryInterceptor } from "./retry.ts";
export { createSerializerInterceptor } from "./serializer.ts";
export { createTimeoutInterceptor } from "./timeout.ts";

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
