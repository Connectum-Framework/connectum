/**
 * @connectum/otel
 *
 * OpenTelemetry instrumentation for Connectum.
 *
 * @module @connectum/otel
 * @mergeModuleWith <project>
 */

// Re-export OpenTelemetry API types for convenience
export type { Meter, Tracer } from "@opentelemetry/api";
// Semantic conventions
export {
    ATTR_ERROR_TYPE,
    ATTR_NETWORK_PEER_ADDRESS,
    ATTR_NETWORK_PEER_PORT,
    ATTR_NETWORK_PROTOCOL_NAME,
    ATTR_NETWORK_TRANSPORT,
    ATTR_RPC_CONNECT_RPC_STATUS_CODE,
    ATTR_RPC_METHOD,
    ATTR_RPC_SERVICE,
    ATTR_RPC_SYSTEM,
    ATTR_SERVER_ADDRESS,
    ATTR_SERVER_PORT,
    ConnectErrorCode,
    ConnectErrorCodeName,
    RPC_SYSTEM_CONNECT_RPC,
} from "./attributes.ts";
// Client interceptor (outgoing RPC tracing + metrics)
export { createOtelClientInterceptor } from "./client-interceptor.ts";
export type {
    BatchSpanProcessorOptions,
    CollectorOptions,
    OTLPSettings,
} from "./config.ts";
// Config
export {
    ExporterType,
    getBatchSpanProcessorOptions,
    getCollectorOptions,
    getOTLPSettings,
    getServiceMetadata,
} from "./config.ts";
// Server interceptor (RPC-level tracing + metrics)
export { createOtelInterceptor } from "./interceptor.ts";
export type { Logger, LoggerOptions } from "./logger.ts";
// Logger (correlated logging with trace_id/span_id)
export { getLogger } from "./logger.ts";
export { getMeter } from "./meter.ts";
export type { RpcClientMetrics, RpcServerMetrics } from "./metrics.ts";
// Metrics
export { createRpcClientMetrics, createRpcServerMetrics } from "./metrics.ts";
export type { ProviderOptions } from "./provider.ts";
// Provider management
export { getProvider, initProvider, shutdownProvider } from "./provider.ts";
// Shared utilities (for advanced users)
export { buildErrorAttributes, estimateMessageSize } from "./shared.ts";
export { traceAll } from "./traceAll.ts";
// Deep tracing helpers (business logic instrumentation)
export { traced } from "./traced.ts";
// Standalone instances (lazy)
export { getTracer } from "./tracer.ts";
// Types
export type {
    ArgsFilter,
    MethodArgsFilter,
    OtelAttributeFilter,
    OtelBaseOptions,
    OtelClientInterceptorOptions,
    OtelFilter,
    OtelInterceptorOptions,
    TraceAllOptions,
    TracedOptions,
} from "./types.ts";
