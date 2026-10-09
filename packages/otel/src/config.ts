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
 * - OTLP_HTTP: Sends telemetry via OTLP/HTTP, JSON-encoded (`Content-Type: application/json`)
 * - OTLP_HTTP_PROTOBUF: Sends telemetry via OTLP/HTTP, protobuf-encoded (`Content-Type: application/x-protobuf`)
 * - OTLP_GRPC: Sends telemetry via OTLP/gRPC protocol
 * - NONE: Disables telemetry export
 */
export const ExporterType = {
    CONSOLE: "console",
    OTLP_HTTP: "otlp/http",
    OTLP_HTTP_PROTOBUF: "otlp/http-protobuf",
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

/** Telemetry signal, as spelled inside the `OTEL_EXPORTER_OTLP_<SIGNAL>_*` variable names. */
export type OTLPSignal = "TRACES" | "METRICS" | "LOGS";

/** URL path an OTLP/HTTP collector serves each signal on. */
const HTTP_SIGNAL_PATH: Record<OTLPSignal, string> = {
    TRACES: "v1/traces",
    METRICS: "v1/metrics",
    LOGS: "v1/logs",
};

const EXPORTER_VALUES = ["console", "otlp", "otlp/http", "otlp/http-protobuf", "otlp/grpc", "none"];
const PROTOCOL_VALUES = ["grpc", "http/protobuf", "http/json"];

/**
 * Resolves one signal's exporter. The standard bare `otlp` value defers to the
 * protocol variables (per-signal first, then the general one); with none set the
 * OpenTelemetry default, `http/protobuf`, applies. `otlp/http` (JSON),
 * `otlp/http-protobuf` and `otlp/grpc` are explicit and ignore the protocol variables.
 */
function resolveExporter(signal: OTLPSignal): ExporterType {
    const exporter = env.get(`OTEL_${signal}_EXPORTER`).asEnum(EXPORTER_VALUES);
    if (exporter !== "otlp") {
        return exporter as ExporterType;
    }
    const protocol = env.get(`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`).asEnum(PROTOCOL_VALUES) ?? env.get("OTEL_EXPORTER_OTLP_PROTOCOL").asEnum(PROTOCOL_VALUES);
    if (protocol === "grpc") {
        return ExporterType.OTLP_GRPC;
    }
    return protocol === "http/json" ? ExporterType.OTLP_HTTP : ExporterType.OTLP_HTTP_PROTOBUF;
}

/**
 * Gets OTLP exporter settings from environment variables
 *
 * Environment variables:
 * - OTEL_TRACES_EXPORTER: Trace exporter type (console|otlp|otlp/http|otlp/http-protobuf|otlp/grpc|none)
 * - OTEL_METRICS_EXPORTER: Metric exporter type (console|otlp|otlp/http|otlp/http-protobuf|otlp/grpc|none)
 * - OTEL_LOGS_EXPORTER: Logs exporter type (console|otlp|otlp/http|otlp/http-protobuf|otlp/grpc|none)
 * - OTEL_EXPORTER_OTLP_PROTOCOL (and OTEL_EXPORTER_OTLP_<TRACES|METRICS|LOGS>_PROTOCOL):
 *   transport for the bare `otlp` value (grpc|http/protobuf|http/json); `grpc` selects
 *   OTLP/gRPC, `http/protobuf` protobuf-encoded OTLP/HTTP, `http/json` JSON-encoded
 *   OTLP/HTTP; unset means `http/protobuf`
 *
 * @returns OTLP settings object
 */
export function getOTLPSettings(): OTLPSettings {
    return {
        traces: resolveExporter("TRACES"),
        metrics: resolveExporter("METRICS"),
        logs: resolveExporter("LOGS"),
    };
}

/**
 * Gets collector endpoint options from environment variables
 *
 * Environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: Collector endpoint URL; empty is treated as not set
 *
 * @returns Collector options object
 */
export function getCollectorOptions(): CollectorOptions {
    const replaceRule = /\/$/;
    return {
        concurrencyLimit: 10,
        url: env.get("OTEL_EXPORTER_OTLP_ENDPOINT").asString()?.replace(replaceRule, "") || undefined,
    };
}

/**
 * Builds the options for one signal's OTLP/HTTP exporter.
 *
 * The `url` is set only when a base endpoint is configured and no
 * `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` exists: the signal path is appended to the
 * base endpoint. Otherwise it is left out so the exporter applies the per-signal
 * endpoint as given, or its own default (`http://localhost:4318/<path>`). Passing
 * a URL built from an unset endpoint would make the exporter reject it.
 */
export function getHttpExporterOptions(collector: CollectorOptions, signal: OTLPSignal): { concurrencyLimit: number; url?: string } {
    const signalEndpoint = env.get(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`).asString();
    if (collector.url === undefined || signalEndpoint) {
        return { concurrencyLimit: collector.concurrencyLimit };
    }
    return { concurrencyLimit: collector.concurrencyLimit, url: `${collector.url}/${HTTP_SIGNAL_PATH[signal]}` };
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
 * Uses OTEL_SERVICE_NAME, then npm_package_name, then "unknown-service" for the name.
 * The version comes from npm_package_version, falling back to "0.0.0".
 *
 * @returns Service name and version
 */
export function getServiceMetadata(): { name: string; version: string } {
    return {
        name: process.env.OTEL_SERVICE_NAME || process.env.npm_package_name || "unknown-service",
        version: process.env.npm_package_version || "0.0.0",
    };
}
