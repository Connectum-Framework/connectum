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
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { CollectorOptions, OTLPSettings } from "./config.ts";
import { ExporterType, getBatchSpanProcessorOptions, getCollectorOptions, getOTLPSettings, getServiceMetadata } from "./config.ts";

/**
 * Options for initializing the OpenTelemetry provider
 */
export interface ProviderOptions {
    /** Override service name (defaults to OTEL_SERVICE_NAME or npm_package_name) */
    serviceName?: string;
    /** Override service version (defaults to npm_package_version) */
    serviceVersion?: string;
    /** Override OTLP exporter settings (defaults to env-based config) */
    settings?: Partial<OTLPSettings>;
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

        // Initialize providers
        this.tracer = this.createTracer();
        this.meter = this.createMeter();
        this.logger = this.createLogger();
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

        // Create resource with service metadata
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: this.serviceName,
            [ATTR_SERVICE_VERSION]: this.serviceVersion,
        });

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
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: this.serviceName,
                [ATTR_SERVICE_VERSION]: this.serviceVersion,
            }),
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
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: this.serviceName,
                [ATTR_SERVICE_VERSION]: this.serviceVersion,
            }),
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
 * Must be called before any telemetry is emitted if custom configuration
 * is needed. Throws if already initialized -- call {@link shutdownProvider}
 * first to re-initialize.
 *
 * @param options - Optional provider configuration overrides
 * @throws Error if provider is already initialized
 */
export function initProvider(options?: ProviderOptions): void {
    if (provider !== undefined) {
        throw new Error("OTel provider already initialized. Call shutdownProvider() first.");
    }
    provider = new OtelProvider(options);
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
