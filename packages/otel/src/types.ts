/**
 * Type definitions for @connectum/otel
 *
 * Contains all option types for the OTel interceptor, traced(), and traceAll().
 *
 * @module types
 */

/**
 * Filter callback to skip specific RPC requests from instrumentation
 *
 * @param context - RPC call context
 * @returns `true` to instrument, `false` to skip
 */
export type OtelFilter = (context: {
    service: string;
    method: string;
    stream: boolean;
}) => boolean;

/**
 * Filter callback to exclude specific attributes from spans/metrics
 *
 * @param key - Attribute key
 * @param value - Attribute value
 * @returns `true` to include, `false` to exclude
 */
export type OtelAttributeFilter = (key: string, value: string | number | boolean) => boolean;

/**
 * Common options shared between server and client OTel interceptors
 */
export interface OtelBaseOptions {
    /** Disable span creation (metrics only) */
    withoutTracing?: boolean;

    /** Disable metric recording (tracing only) */
    withoutMetrics?: boolean;

    /** Filter callback to skip specific requests */
    filter?: OtelFilter;

    /** Filter callback to exclude specific attributes */
    attributeFilter?: OtelAttributeFilter;

    /**
     * Include request/response message content in span events.
     * WARNING: May contain sensitive data.
     * @default false
     */
    recordMessages?: boolean;
}

/**
 * Options for createOtelInterceptor() (server-side)
 */
export interface OtelInterceptorOptions extends OtelBaseOptions {
    /**
     * Use extracted remote context as parent span.
     * When false, creates a new root span and adds a link to the remote span.
     * @default false
     */
    trustRemote?: boolean;

    /**
     * Override server.address attribute (defaults to os.hostname())
     */
    serverAddress?: string;

    /**
     * Opt-in server.port attribute
     */
    serverPort?: number;
}

/**
 * Options for createOtelClientInterceptor() (client-side)
 */
export interface OtelClientInterceptorOptions extends OtelBaseOptions {
    /**
     * Target server address (required for client spans).
     * Used as `server.address` attribute.
     */
    serverAddress: string;

    /**
     * Target server port.
     * Used as `server.port` attribute.
     */
    serverPort?: number;
}

// --- Deep tracing types ---

/**
 * Args filter for traced() -- sanitize/transform function arguments before recording
 */
export type ArgsFilter = (args: unknown[]) => unknown[];

/**
 * Args filter for traceAll() -- has access to method name
 */
export type MethodArgsFilter = (methodName: string, args: unknown[]) => unknown[];

/**
 * Options for traced() function wrapper
 */
export interface TracedOptions {
    /**
     * Span name. Defaults to fn.name or "anonymous"
     */
    name?: string;

    /**
     * Record function arguments as span attributes.
     * - `false` (default): no args recorded
     * - `true`: all args recorded
     * - `string[]`: whitelist of argument names/indices
     */
    recordArgs?: boolean | string[];

    /**
     * Additional transform/masking for recorded args.
     * Called after whitelist filtering.
     */
    argsFilter?: ArgsFilter;

    /**
     * Custom attributes to add to every span
     */
    attributes?: Record<string, string | number | boolean>;
}

/**
 * Options for traceAll() Proxy-based object wrapper
 */
export interface TraceAllOptions {
    /**
     * Prefix for span names: "${prefix}.${methodName}"
     * Defaults to constructor.name or "Object"
     */
    prefix?: string;

    /** Whitelist of method names to wrap (if provided, only these are wrapped) */
    include?: string[];

    /** Blacklist of method names to exclude from wrapping */
    exclude?: string[];

    /**
     * Record method arguments as span attributes.
     * - `false` (default): no args recorded
     * - `true`: all args recorded
     * - `string[]`: whitelist of argument names/indices
     */
    recordArgs?: boolean | string[];

    /**
     * Transform/masking for recorded args -- has access to method name.
     */
    argsFilter?: MethodArgsFilter;
}
