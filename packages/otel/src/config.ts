/**
 * OpenTelemetry configuration module
 *
 * Provides environment-based configuration for OTLP exporters.
 *
 * @module config
 */

import env from "env-var";

/**
 * Available exporter types
 *
 * - CONSOLE: Outputs telemetry to stdout
 * - OTLP_HTTP: Sends telemetry via OTLP/HTTP protocol
 * - OTLP_GRPC: Sends telemetry via OTLP/gRPC protocol
 * - NONE: Disables telemetry export
 */
export const ExporterType = {
    CONSOLE: "console",
    OTLP_HTTP: "otlp/http",
    OTLP_GRPC: "otlp/grpc",
    NONE: "none",
} as const;

export type ExporterType = (typeof ExporterType)[keyof typeof ExporterType];

/**
 * OTLP settings for traces, metrics, and logs
 */
export interface OTLPSettings {
    traces: ExporterType;
    metrics: ExporterType;
    logs: ExporterType;
}

/**
 * Collector endpoint options
 */
export interface CollectorOptions {
    concurrencyLimit: number;
    url: string | undefined;
}

/**
 * Batch span processor options
 */
export interface BatchSpanProcessorOptions {
    maxExportBatchSize: number;
    maxQueueSize: number;
    scheduledDelayMillis: number;
    exportTimeoutMillis: number;
}

/**
 * Gets OTLP exporter settings from environment variables
 *
 * Environment variables:
 * - OTEL_TRACES_EXPORTER: Trace exporter type (console|otlp/http|otlp/grpc|none)
 * - OTEL_METRICS_EXPORTER: Metric exporter type (console|otlp/http|otlp/grpc|none)
 * - OTEL_LOGS_EXPORTER: Logs exporter type (console|otlp/http|otlp/grpc|none)
 *
 * @returns OTLP settings object
 */
export function getOTLPSettings(): OTLPSettings {
    return {
        traces: env.get("OTEL_TRACES_EXPORTER").asEnum(["console", "otlp/http", "otlp/grpc", "none"]) as ExporterType,
        metrics: env.get("OTEL_METRICS_EXPORTER").asEnum(["console", "otlp/http", "otlp/grpc", "none"]) as ExporterType,
        logs: env.get("OTEL_LOGS_EXPORTER").asEnum(["console", "otlp/http", "otlp/grpc", "none"]) as ExporterType,
    };
}

/**
 * Gets collector endpoint options from environment variables
 *
 * Environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: Collector endpoint URL
 *
 * @returns Collector options object
 */
export function getCollectorOptions(): CollectorOptions {
    const replaceRule = /\/$/;
    return {
        concurrencyLimit: 10,
        url: env.get("OTEL_EXPORTER_OTLP_ENDPOINT").asString()?.replace(replaceRule, ""),
    };
}

/**
 * Gets batch span processor options from environment variables
 *
 * Environment variables:
 * - OTEL_BSP_MAX_EXPORT_BATCH_SIZE: Max number of spans to export in a single batch (default: 100)
 * - OTEL_BSP_MAX_QUEUE_SIZE: Max queue size - if reached, new spans are dropped (default: 1000)
 * - OTEL_BSP_SCHEDULE_DELAY: Time to wait before automatically exporting spans in ms (default: 1000)
 * - OTEL_BSP_EXPORT_TIMEOUT: Max time allowed for a single export operation in ms (default: 10000)
 *
 * @returns Batch span processor options
 */
export function getBatchSpanProcessorOptions(): BatchSpanProcessorOptions {
    return {
        maxExportBatchSize: env.get("OTEL_BSP_MAX_EXPORT_BATCH_SIZE").default(100).asIntPositive(),
        maxQueueSize: env.get("OTEL_BSP_MAX_QUEUE_SIZE").default(1000).asIntPositive(),
        scheduledDelayMillis: env.get("OTEL_BSP_SCHEDULE_DELAY").default(1000).asIntPositive(),
        exportTimeoutMillis: env.get("OTEL_BSP_EXPORT_TIMEOUT").default(10000).asIntPositive(),
    };
}

/**
 * Gets service metadata from environment variables
 *
 * Uses OTEL_SERVICE_NAME as primary source, falls back to npm_package_name.
 *
 * @returns Service name and version
 */
export function getServiceMetadata(): { name: string; version: string } {
    return {
        name: process.env.OTEL_SERVICE_NAME || process.env.npm_package_name || "unknown-service",
        version: process.env.npm_package_version || "0.0.0",
    };
}
