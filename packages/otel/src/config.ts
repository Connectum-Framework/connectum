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

const EXPORTER_VALUES = ["console", "otlp", "otlp/http", "otlp/http-protobuf", "otlp/grpc", "none"] as const;
const PROTOCOL_VALUES = ["grpc", "http/protobuf", "http/json"] as const;

/** Code of every process warning this module emits about an unusable environment value. */
const INVALID_ENV_CODE = "CONNECTUM_OTEL_INVALID_ENV";

/**
 * Reports an unusable environment value. It goes through `process.emitWarning`
 * rather than the OpenTelemetry diagnostic channel: the provider sets that
 * channel to ERROR level, which would hide it.
 *
 * Nothing in this module throws for a value read from the environment. The
 * provider is created lazily by the first instrumented call, so an exception
 * would fail that call, leave the provider uncreated and fail the next one the
 * same way.
 */
function warnInvalidEnv(message: string): void {
    process.emitWarning(message, { code: INVALID_ENV_CODE });
}

/** A variable that is set and not empty; the specification treats an empty value as unset. */
function nonEmptyEnv(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads an enum variable: empty counts as unset, matching is case-insensitive,
 * and an unrecognised value yields a warning and `undefined`, as the
 * OpenTelemetry specification requires.
 */
function enumFromEnv<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const raw = nonEmptyEnv(name);
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.toLowerCase();
    const match = allowed.find((candidate) => candidate === value);
    if (match === undefined) {
        warnInvalidEnv(`${name}="${raw}" is not one of ${allowed.join(", ")}; the variable is ignored.`);
    }
    return match;
}

/**
 * Resolves one signal's exporter. A variable that is unset, empty or not
 * recognised yields the default, `console`. The standard bare `otlp` value
 * defers to the protocol variables (per-signal first, then the general one);
 * with none usable the OpenTelemetry default, `http/protobuf`, applies.
 * `otlp/http` (JSON), `otlp/http-protobuf` and `otlp/grpc` are explicit and
 * ignore the protocol variables.
 */
function resolveExporter(signal: OTLPSignal): ExporterType {
    const exporter = enumFromEnv(`OTEL_${signal}_EXPORTER`, EXPORTER_VALUES);
    if (exporter === undefined) {
        return ExporterType.CONSOLE;
    }
    if (exporter !== "otlp") {
        return exporter;
    }
    const protocol = enumFromEnv(`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`, PROTOCOL_VALUES) ?? enumFromEnv("OTEL_EXPORTER_OTLP_PROTOCOL", PROTOCOL_VALUES);
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
 * An exporter variable that is unset, empty or not recognised yields `console`. This
 * differs from the OpenTelemetry specification, which names `otlp` as the default; the
 * package keeps `console` so that a service without any `OTEL_*` variable behaves as it
 * always did. Values are matched case-insensitively. A value that is not recognised
 * (a comma-separated list included) is ignored with a process warning (code
 * `CONNECTUM_OTEL_INVALID_ENV`); this function never throws for the environment.
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
 * A value that cannot be a URL is ignored with a process warning (code
 * `CONNECTUM_OTEL_INVALID_ENV`) and reads as not set. A bare `host:port` is kept: the
 * OTLP/gRPC exporter accepts it, and the OTLP/HTTP exporters check the scheme themselves
 * (see `getHttpExporterOptions`).
 *
 * @returns Collector options object
 */
export function getCollectorOptions(): CollectorOptions {
    const raw = nonEmptyEnv("OTEL_EXPORTER_OTLP_ENDPOINT");
    if (raw !== undefined && !isUsableEndpoint(raw, "grpc")) {
        warnInvalidEnv(`OTEL_EXPORTER_OTLP_ENDPOINT="${raw}" is not a URL; the variable is ignored and the exporter default applies.`);
        return { concurrencyLimit: 10, url: undefined };
    }
    return {
        concurrencyLimit: 10,
        url: raw?.replace(/\/$/, ""),
    };
}

/** Where each exporter family sends telemetry when no endpoint is configured. */
const DEFAULT_HTTP_ORIGIN = "http://localhost:4318";
const DEFAULT_GRPC_URL = "http://localhost:4317";

/**
 * Whether the exporters of a transport can use an endpoint.
 *
 * OTLP/HTTP appends a signal path to the endpoint and sends over `http:` or
 * `https:`; anything else (a bare `host:port` parses as the scheme `host:`) fails on
 * the first export, which surfaces only when the provider is shut down. The OTLP/gRPC
 * exporter prepends `https://` to a value without a scheme, so there only text that
 * does not parse as a URL after that is unusable.
 */
function isUsableEndpoint(value: string, transport: "http" | "grpc"): boolean {
    const text = value.trim();
    try {
        if (transport === "http") {
            const { protocol } = new URL(text);
            return protocol === "http:" || protocol === "https:";
        }
        return URL.canParse(/^\w{1,8}:\/\//.test(text) ? text : `https://${text}`);
    } catch {
        return false;
    }
}

/**
 * Builds the options for one signal's OTLP/HTTP exporter.
 *
 * The `url` is set only when a base endpoint is configured and no usable
 * `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` exists: the signal path is appended to the
 * base endpoint. Otherwise it is left out so the exporter applies the per-signal
 * endpoint as given, or its own default (`http://localhost:4318/<path>`). Passing
 * a URL built from an unset endpoint would make the exporter reject it.
 *
 * An endpoint without an `http:` or `https:` scheme (`localhost:4318`) is ignored with a
 * process warning (code `CONNECTUM_OTEL_INVALID_ENV`). An unusable per-signal endpoint
 * is replaced by an explicit URL (the base endpoint, else the exporter default), since
 * the exporter would otherwise read the broken variable itself.
 */
export function getHttpExporterOptions(collector: CollectorOptions, signal: OTLPSignal): { concurrencyLimit: number; url?: string } {
    const options = { concurrencyLimit: collector.concurrencyLimit };
    const signalVariable = `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`;
    const signalEndpoint = nonEmptyEnv(signalVariable);
    const signalUsable = signalEndpoint === undefined || isUsableEndpoint(signalEndpoint, "http");
    if (signalEndpoint !== undefined && signalUsable) {
        return options;
    }
    if (!signalUsable) {
        warnInvalidEnv(`${signalVariable}="${signalEndpoint}" is not an http: or https: URL and cannot be used by the OTLP/HTTP exporter; the variable is ignored.`);
    }
    const base = collector.url;
    if (base !== undefined && isUsableEndpoint(base, "http")) {
        return { ...options, url: `${base}/${HTTP_SIGNAL_PATH[signal]}` };
    }
    if (base !== undefined) {
        warnInvalidEnv(`OTEL_EXPORTER_OTLP_ENDPOINT="${base}" is not an http: or https: URL and cannot be used by the OTLP/HTTP exporter; the exporter default applies.`);
    }
    // Nothing usable is configured. When a variable is nevertheless set, the exporter would read
    // it again from the environment (and fail on the first export), so the default is passed
    // explicitly.
    const brokenVariableSet = !signalUsable || nonEmptyEnv("OTEL_EXPORTER_OTLP_ENDPOINT") !== undefined;
    return brokenVariableSet ? { ...options, url: `${DEFAULT_HTTP_ORIGIN}/${HTTP_SIGNAL_PATH[signal]}` } : options;
}

/**
 * Builds the options for one signal's OTLP/gRPC exporter.
 *
 * The base endpoint, when set, is passed explicitly and takes precedence over the
 * per-signal variables. Otherwise the `url` is left out so the exporter reads its own
 * defaults, unless the per-signal endpoint cannot be parsed: the exporter would throw
 * while it is constructed, so it is replaced by the exporter default and a process
 * warning (code `CONNECTUM_OTEL_INVALID_ENV`) names the variable.
 */
export function getGrpcExporterOptions(collector: CollectorOptions, signal: OTLPSignal): { concurrencyLimit: number; url?: string } {
    const options = { concurrencyLimit: collector.concurrencyLimit };
    if (collector.url !== undefined) {
        return { ...options, url: collector.url };
    }
    const signalVariable = `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`;
    const signalEndpoint = nonEmptyEnv(signalVariable);
    const signalUsable = signalEndpoint === undefined || isUsableEndpoint(signalEndpoint, "grpc");
    if (!signalUsable) {
        warnInvalidEnv(`${signalVariable}="${signalEndpoint}" is not a URL; the variable is ignored and the exporter default applies.`);
    }
    // getCollectorOptions() has already reported and dropped an unusable base endpoint, but the
    // exporter would read the variable again from the environment and throw, so a usable signal
    // endpoint or the default is passed explicitly.
    if (!signalUsable || nonEmptyEnv("OTEL_EXPORTER_OTLP_ENDPOINT") !== undefined) {
        return { ...options, url: signalUsable && signalEndpoint !== undefined ? signalEndpoint : DEFAULT_GRPC_URL };
    }
    return options;
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
 * A value that is not an integer, or is negative, is ignored with a process warning and the
 * default is used, as the OpenTelemetry specification asks for invalid numeric
 * variables. `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` and `OTEL_BSP_MAX_QUEUE_SIZE` must also be at
 * least 1: a queue of size 0 drops every span without a trace, and a batch of size 0 makes the
 * span processor allocate until the process runs out of memory (both measured with
 * `@opentelemetry/sdk-trace-node`), so 0 is treated as invalid for them. The two durations
 * accept 0. The provider is created lazily on the first traced call, so throwing here
 * would fail that user call.
 *
 * @returns Batch span processor options
 */
export function getBatchSpanProcessorOptions(): BatchSpanProcessorOptions {
    return {
        maxExportBatchSize: countFromEnv({ name: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", fallback: 100, minimum: 1 }),
        maxQueueSize: countFromEnv({ name: "OTEL_BSP_MAX_QUEUE_SIZE", fallback: 1000, minimum: 1 }),
        scheduledDelayMillis: countFromEnv({ name: "OTEL_BSP_SCHEDULE_DELAY", fallback: 1000, minimum: 0 }),
        exportTimeoutMillis: countFromEnv({ name: "OTEL_BSP_EXPORT_TIMEOUT", fallback: 10000, minimum: 0 }),
    };
}

/**
 * Reads an integer of at least `minimum` from the environment; an invalid value yields a warning
 * and `fallback`.
 *
 * The warning goes through `process.emitWarning` rather than the OpenTelemetry
 * diagnostic channel: the provider sets that channel to ERROR level, which would hide it.
 */
function countFromEnv(options: { readonly name: string; readonly fallback: number; readonly minimum: 0 | 1 }): number {
    const { name, fallback, minimum } = options;
    try {
        const value = env.get(name).default(fallback).asIntPositive();
        if (value < minimum) {
            throw new RangeError(`${name} is below ${minimum}`);
        }
        return value;
    } catch {
        const kind = minimum === 1 ? "positive" : "non-negative";
        warnInvalidEnv(`${name}="${process.env[name]}" is not a valid ${kind} integer; using the default ${fallback}.`);
        return fallback;
    }
}

/**
 * Gets service metadata from environment variables
 *
 * Uses OTEL_SERVICE_NAME, then npm_package_name, then "unknown-service" for the name.
 * The version comes from npm_package_version, falling back to "0.0.0".
 *
 * This reads the process environment only. The service name the provider reports is resolved
 * separately and also honours the `serviceName` option and the `service.name` entry of
 * `OTEL_RESOURCE_ATTRIBUTES` (between `OTEL_SERVICE_NAME` and `npm_package_name`), so for a
 * service configured that way the name returned here is not the one on its telemetry.
 *
 * @returns Service name and version
 */
export function getServiceMetadata(): { name: string; version: string } {
    return {
        name: process.env.OTEL_SERVICE_NAME || process.env.npm_package_name || "unknown-service",
        version: process.env.npm_package_version || "0.0.0",
    };
}
