/**
 * OpenTelemetry Provider
 *
 * Manages OpenTelemetry providers for traces, metrics, and logs.
 * Replaces the previous OTLPProvider singleton with explicit lifecycle control.
 *
 * @module provider
 */

import type { Meter, Tracer } from "@opentelemetry/api";
import { DiagConsoleLogger, DiagLogLevel, diag, metrics, trace } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { CollectorOptions, OTLPSettings } from "./config.ts";
import { ExporterType, getBatchSpanProcessorOptions, getCollectorOptions, getOTLPSettings, getServiceMetadata } from "./config.ts";

/** OpenTelemetry semconv key for the service instance id. */
const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";

/**
 * Options for initializing the OpenTelemetry provider
 */
export interface ProviderOptions {
    /** Override service name (defaults to OTEL_SERVICE_NAME or npm_package_name) */
    serviceName?: string;
    /** Override service version (defaults to npm_package_version) */
    serviceVersion?: string;
    /**
     * Sets `service.instance.id` on the resource (OTel semconv). Lets a fleet of
     * same-role processes be told apart in telemetry. Takes precedence over the
     * `OTEL_SERVICE_INSTANCE_ID` env var.
     */
    instanceId?: string;
    /**
     * Extra resource attributes merged into the resource (e.g. `device.id`,
     * `facility`). Applied to traces, metrics, and logs alike. Takes precedence
     * over attributes parsed from the `OTEL_RESOURCE_ATTRIBUTES` env var.
     */
    resourceAttributes?: Record<string, string | number | boolean>;
    /** Override OTLP exporter settings (defaults to env-based config) */
    settings?: Partial<OTLPSettings>;
}

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` env var
 * (`key1=value1,key2=value2`) into an attribute record. Malformed pairs (no
 * `=`, empty key) are skipped. Values are kept as strings; whitespace around
 * keys and values is trimmed.
 */
export function parseOtelResourceAttributesEnv(raw: string | undefined): Record<string, string> {
    if (raw === undefined || raw === "") {
        return {};
    }
    const result: Record<string, string> = {};
    for (const pair of raw.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (key !== "") {
            result[key] = value;
        }
    }
    return result;
}

/** Inputs for {@link buildResourceAttributes}. */
export interface ResourceAttributeInputs {
    serviceName: string;
    serviceVersion: string;
    instanceId?: string | undefined;
    resourceAttributes?: Record<string, string | number | boolean> | undefined;
    /** Environment source (defaults to `process.env`). */
    env?: { OTEL_RESOURCE_ATTRIBUTES?: string; OTEL_SERVICE_INSTANCE_ID?: string } | undefined;
}

/**
 * Build the flat resource-attribute record shared by traces, metrics, and logs.
 *
 * Precedence (lowest to highest): `service.name`/`service.version` → env
 * (`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_INSTANCE_ID`) → explicit
 * `resourceAttributes` → explicit `instanceId`.
 */
export function buildResourceAttributes(inputs: ResourceAttributeInputs): Record<string, string | number | boolean> {
    const env = inputs.env ?? process.env;

    const attributes: Record<string, string | number | boolean> = {
        [ATTR_SERVICE_NAME]: inputs.serviceName,
        [ATTR_SERVICE_VERSION]: inputs.serviceVersion,
        // Env-provided attributes (lower precedence than explicit options).
        ...parseOtelResourceAttributesEnv(env.OTEL_RESOURCE_ATTRIBUTES),
    };

    const envInstanceId = env.OTEL_SERVICE_INSTANCE_ID;
    if (envInstanceId !== undefined && envInstanceId !== "") {
        attributes[ATTR_SERVICE_INSTANCE_ID] = envInstanceId;
    }

    // Explicit options take precedence over env.
    if (inputs.resourceAttributes !== undefined) {
        Object.assign(attributes, inputs.resourceAttributes);
    }
    if (inputs.instanceId !== undefined && inputs.instanceId !== "") {
        attributes[ATTR_SERVICE_INSTANCE_ID] = inputs.instanceId;
    }

    return attributes;
}

/**
 * OpenTelemetry Provider
 *
 * Manages OTLP exporters for traces, metrics, and logs.
 * Supports console, OTLP/HTTP, OTLP/gRPC exporters, and no-op mode
 * based on environment configuration or explicit options.
 */
class OtelProvider {
    readonly tracer: Tracer;
    readonly meter: Meter;
    readonly logger: Logger;

    private traceProvider?: NodeTracerProvider;
    private meterProvider?: MeterProvider;
    private loggerProvider?: LoggerProvider;

    private readonly settings: OTLPSettings;
    private readonly collectorOptions: CollectorOptions;
    private readonly serviceName: string;
    private readonly serviceVersion: string;
    private readonly resource: Resource;

    constructor(options?: ProviderOptions) {
        // Set diagnostic logger to ERROR level
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

        // Load configuration from environment, apply overrides
        const envSettings = getOTLPSettings();
        this.settings = {
            traces: options?.settings?.traces ?? envSettings.traces,
            metrics: options?.settings?.metrics ?? envSettings.metrics,
            logs: options?.settings?.logs ?? envSettings.logs,
        };

        this.collectorOptions = getCollectorOptions();

        const metadata = getServiceMetadata();
        this.serviceName = options?.serviceName ?? metadata.name;
        this.serviceVersion = options?.serviceVersion ?? metadata.version;

        // Build the resource once and share it across traces, metrics, and logs
        // so service.instance.id and custom attributes apply to every signal.
        this.resource = this.buildResource(options);

        // Initialize providers
        this.tracer = this.createTracer();
        this.meter = this.createMeter();
        this.logger = this.createLogger();
    }

    /**
     * Build the OpenTelemetry resource from service metadata, environment
     * variables, and explicit options. See {@link buildResourceAttributes} for
     * the precedence rules.
     */
    private buildResource(options?: ProviderOptions): Resource {
        return resourceFromAttributes(
            buildResourceAttributes({
                serviceName: this.serviceName,
                serviceVersion: this.serviceVersion,
                instanceId: options?.instanceId,
                resourceAttributes: options?.resourceAttributes,
            }),
        );
    }

    /**
     * Create and configure tracer provider
     *
     * @returns Tracer instance
     */
    private createTracer(): Tracer {
        // If tracing is disabled, use no-op tracer from global API
        if (this.settings.traces === ExporterType.NONE) {
            return trace.getTracer(this.serviceName, this.serviceVersion);
        }

        // Shared resource (service metadata + instance id + custom attributes)
        const resource = this.resource;

        // Create exporter based on protocol
        let traceExporter: OTLPTraceExporterHTTP | OTLPTraceExporterGRPC | ConsoleSpanExporter;
        if (this.settings.traces === ExporterType.OTLP_HTTP) {
            traceExporter = new OTLPTraceExporterHTTP({
                ...this.collectorOptions,
                url: `${this.collectorOptions.url}/v1/traces`,
            });
        } else if (this.settings.traces === ExporterType.OTLP_GRPC) {
            traceExporter = new OTLPTraceExporterGRPC(
                this.collectorOptions.url ? { ...this.collectorOptions, url: this.collectorOptions.url } : { concurrencyLimit: this.collectorOptions.concurrencyLimit },
            );
        } else {
            // Default to console
            traceExporter = new ConsoleSpanExporter();
        }

        // Get batch span processor options
        const batchOptions = getBatchSpanProcessorOptions();

        // Create and register tracer provider
        this.traceProvider = new NodeTracerProvider({
            resource,
            spanProcessors: [
                new BatchSpanProcessor(traceExporter, {
                    maxExportBatchSize: batchOptions.maxExportBatchSize,
                    maxQueueSize: batchOptions.maxQueueSize,
                    scheduledDelayMillis: batchOptions.scheduledDelayMillis,
                    exportTimeoutMillis: batchOptions.exportTimeoutMillis,
                }),
            ],
        });

        this.traceProvider.register();

        return this.traceProvider.getTracer(this.serviceName, this.serviceVersion);
    }

    /**
     * Create and configure meter provider
     *
     * @returns Meter instance
     */
    private createMeter(): Meter {
        // If metrics are disabled, use no-op meter from global API
        if (this.settings.metrics === ExporterType.NONE) {
            return metrics.getMeter(this.serviceName, this.serviceVersion);
        }

        // Create exporter based on protocol
        let metricExporter: OTLPMetricExporterHTTP | OTLPMetricExporterGRPC | ConsoleMetricExporter;
        if (this.settings.metrics === ExporterType.OTLP_HTTP) {
            metricExporter = new OTLPMetricExporterHTTP({
                ...this.collectorOptions,
                url: `${this.collectorOptions.url}/v1/metrics`,
            });
        } else if (this.settings.metrics === ExporterType.OTLP_GRPC) {
            metricExporter = new OTLPMetricExporterGRPC(
                this.collectorOptions.url ? { ...this.collectorOptions, url: this.collectorOptions.url } : { concurrencyLimit: this.collectorOptions.concurrencyLimit },
            );
        } else {
            // Default to console
            metricExporter = new ConsoleMetricExporter();
        }

        // Create meter provider with periodic exporter
        this.meterProvider = new MeterProvider({
            resource: this.resource,
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 10000, // Export every 10 seconds
                }),
            ],
        });

        // Set global meter provider
        metrics.setGlobalMeterProvider(this.meterProvider);

        return metrics.getMeter(this.serviceName, this.serviceVersion);
    }

    /**
     * Create and configure logger provider
     *
     * @returns Logger instance
     */
    private createLogger(): Logger {
        // If logging is disabled, use no-op logger from global API
        if (this.settings.logs === ExporterType.NONE) {
            return logs.getLogger(this.serviceName, this.serviceVersion);
        }

        // Create exporter based on protocol
        let logExporter: OTLPLogExporterHTTP | OTLPLogExporterGRPC | ConsoleLogRecordExporter;
        if (this.settings.logs === ExporterType.OTLP_HTTP) {
            logExporter = new OTLPLogExporterHTTP({
                ...this.collectorOptions,
                url: `${this.collectorOptions.url}/v1/logs`,
            });
        } else if (this.settings.logs === ExporterType.OTLP_GRPC) {
            logExporter = new OTLPLogExporterGRPC(
                this.collectorOptions.url ? { ...this.collectorOptions, url: this.collectorOptions.url } : { concurrencyLimit: this.collectorOptions.concurrencyLimit },
            );
        } else {
            // Default to console
            logExporter = new ConsoleLogRecordExporter();
        }

        // Create logger provider with processors
        this.loggerProvider = new LoggerProvider({
            resource: this.resource,
            processors: [new SimpleLogRecordProcessor(logExporter)],
        });

        // Set global logger provider
        logs.setGlobalLoggerProvider(this.loggerProvider);

        return this.loggerProvider.getLogger(this.serviceName, this.serviceVersion);
    }

    /**
     * Gracefully shutdown all OTLP providers
     *
     * @returns Promise that resolves when shutdown is complete
     */
    async shutdown(): Promise<void> {
        console.debug("OTel provider shutdown...");
        await this.traceProvider?.shutdown();
        await this.meterProvider?.shutdown();
        await this.loggerProvider?.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let provider: OtelProvider | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the OpenTelemetry provider with explicit options.
 *
 * Optional -- {@link getProvider}, {@link getMeter}, {@link getTracer},
 * and {@link getLogger} auto-initialize with environment-based defaults.
 * Idempotent: subsequent calls are no-ops if provider is already active.
 * Call {@link shutdownProvider} first to re-initialize with new options.
 *
 * @param options - Optional provider configuration overrides
 */
export function initProvider(options?: ProviderOptions): void {
    if (provider === undefined) {
        provider = new OtelProvider(options);
    }
}

/**
 * Get the current OpenTelemetry provider.
 *
 * If not yet initialized, lazily creates a provider with default
 * (environment-based) options.
 *
 * @returns The active OtelProvider instance
 */
export function getProvider(): OtelProvider {
    if (provider === undefined) {
        provider = new OtelProvider();
    }
    return provider;
}

/**
 * Gracefully shutdown the provider and release resources.
 *
 * After shutdown, subsequent calls to {@link getProvider} will create
 * a fresh provider. If no provider exists, this is a no-op.
 */
export async function shutdownProvider(): Promise<void> {
    if (provider === undefined) {
        return;
    }
    await provider.shutdown();
    provider = undefined;
}
