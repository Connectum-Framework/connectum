/**
 * Shared types for ConnectRPC interceptors
 *
 * Provides common TypeScript types for interceptor development.
 *
 * @module types
 */

import type { Code, Interceptor } from "@connectrpc/connect";

/**
 * Interceptor factory function type
 *
 * @template TOptions - Options type for the interceptor
 */
export type InterceptorFactory<TOptions = void> = TOptions extends void ? () => Interceptor : (options: TOptions) => Interceptor;

/**
 * Error handler interceptor options
 */
export interface ErrorHandlerOptions {
    /**
     * Log errors to console
     * @default process.env.NODE_ENV !== "production"
     */
    logErrors?: boolean;

    /**
     * Include stack trace in logs
     * @default process.env.NODE_ENV !== "production"
     */
    includeStackTrace?: boolean;
}

/**
 * Logger interceptor options
 */
export interface LoggerOptions {
    /**
     * Log level
     * @default "debug"
     */
    level?: "debug" | "info" | "warn" | "error";

    /**
     * Skip logging for health check services
     * @default true
     */
    skipHealthCheck?: boolean;

    /**
     * Custom logger function
     * @default console[level]
     */
    logger?: (message: string, ...args: unknown[]) => void;
}

/**
 * Serializer interceptor options
 */
export interface SerializerOptions {
    /**
     * Skip serialization for gRPC services
     * @default true
     */
    skipGrpcServices?: boolean;

    /**
     * Always emit implicit fields in JSON
     * @default true
     */
    alwaysEmitImplicit?: boolean;

    /**
     * Ignore unknown fields when deserializing
     * @default true
     */
    ignoreUnknownFields?: boolean;
}

/**
 * Retry interceptor options
 */
export interface RetryOptions {
    /**
     * Maximum number of retries
     * @default 3
     */
    maxRetries?: number;

    /**
     * Initial delay in milliseconds for exponential backoff
     * @default 200
     */
    initialDelay?: number;

    /**
     * Maximum delay in milliseconds for exponential backoff
     * @default 5000
     */
    maxDelay?: number;

    /**
     * Skip retry for streaming requests
     * @default true
     */
    skipStreaming?: boolean;

    /**
     * Error codes that trigger a retry
     * @default [Code.Unavailable, Code.ResourceExhausted]
     */
    retryableCodes?: Code[];
}

/**
 * Circuit breaker interceptor options
 */
export interface CircuitBreakerOptions {
    /**
     * Number of consecutive failures before opening circuit
     * @default 5
     */
    threshold?: number;

    /**
     * Time in milliseconds to wait before attempting to close circuit
     * @default 30000 (30 seconds)
     */
    halfOpenAfter?: number;

    /**
     * Skip circuit breaker for streaming calls
     * @default true
     */
    skipStreaming?: boolean;
}

/**
 * Timeout interceptor options
 */
export interface TimeoutOptions {
    /**
     * Request timeout in milliseconds
     * @default 30000 (30 seconds)
     */
    duration?: number;

    /**
     * Skip timeout for streaming calls
     * @default true
     */
    skipStreaming?: boolean;
}

/**
 * Bulkhead interceptor options
 */
export interface BulkheadOptions {
    /**
     * Maximum number of concurrent requests
     * @default 10
     */
    capacity?: number;

    /**
     * Maximum queue size for pending requests
     * @default 10
     */
    queueSize?: number;

    /**
     * Skip bulkhead for streaming calls
     * @default true
     */
    skipStreaming?: boolean;
}

/**
 * Fallback interceptor options
 */
export interface FallbackOptions<T = unknown> {
    /**
     * Fallback function to call on error
     */
    handler: (error: Error) => T | Promise<T>;

    /**
     * Skip fallback for streaming calls
     * @default true
     */
    skipStreaming?: boolean;
}

/**
 * Method pattern to interceptors mapping.
 *
 * Patterns:
 * - `"*"` -- matches all methods (global)
 * - `"package.Service/*"` -- matches all methods of a service (service wildcard)
 * - `"package.Service/Method"` -- matches exact method
 *
 * Key format uses protobuf fully-qualified service name: `service.typeName + "/" + method.name`
 *
 * All matching patterns are executed in order: global -> service wildcard -> exact match.
 * Within each pattern, interceptors execute in array order.
 *
 * @example
 * ```typescript
 * const methods: MethodFilterMap = {
 *   "*": [logRequest],
 *   "admin.v1.AdminService/*": [requireAdmin],
 *   "user.v1.UserService/DeleteUser": [requireAdmin, auditLog],
 * };
 * ```
 */
export type MethodFilterMap = Record<string, Interceptor[]>;
