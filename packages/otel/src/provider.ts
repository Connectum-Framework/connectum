/**
 * OpenTelemetry Provider
 *
 * Manages OpenTelemetry providers for traces, metrics, and logs.
 * Replaces the previous OTLPProvider singleton with explicit lifecycle control.
 *
 * @module provider
 */

import type { Meter, Tracer } from "@opentelemetry/api";
import { context, DiagConsoleLogger, DiagLogLevel, diag, metrics, propagation, trace } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPLogExporterProto } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterProto } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterProto } from "@opentelemetry/exporter-trace-otlp-proto";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ConsoleSpanExporter, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { CollectorOptions, OTLPSettings } from "./config.ts";
import { ExporterType, getBatchSpanProcessorOptions, getCollectorOptions, getHttpExporterOptions, getOTLPSettings, getServiceMetadata } from "./config.ts";

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
 * The process-wide OpenTelemetry provider returned by {@link getProvider}.
 *
 * Manages OTLP exporters for traces, metrics, and logs.
 * Supports console, OTLP/HTTP, OTLP/gRPC exporters, and no-op mode
 * based on environment configuration or explicit options.
 *
 * Only an interface is exported: the package keeps exactly one instance per
 * process, created by {@link initProvider} or lazily by {@link getProvider},
 * so there is deliberately no public constructor. The type lets callers name
 * the value `getProvider()` returns (to store it or pass it on).
 */
export interface OtelProvider {
    /** Tracer bound to the configured service name and version. */
    readonly tracer: Tracer;
    /** Meter bound to the configured service name and version. */
    readonly meter: Meter;
    /** OpenTelemetry Logs API logger bound to the configured service name and version. */
    readonly logger: Logger;
    /**
     * Gracefully shutdown all OTLP providers
     *
     * Tracing, metrics and logging are stopped independently: a failing signal
     * does not keep the others from stopping. Afterwards the OpenTelemetry API
     * global registrations this provider took (and only those) are released.
     * One failure is rethrown as it is; several are combined in an
     * `AggregateError`.
     *
     * Does not clear the process-wide instance: {@link getProvider} keeps
     * returning this (now shut down) provider. Use {@link shutdownProvider} to
     * shut down and allow a fresh provider to be created.
     *
     * @returns Promise that resolves when shutdown is complete
     */
    shutdown(): Promise<void>;
}

/** Process-wide OpenTelemetry API registrations a provider can take. */
type GlobalSlot = "trace" | "context" | "propagation" | "metrics" | "logs";

// Not exported: a second instance would start its own exporters and try to
// register the global tracer, meter and logger providers again, so only
// `initProvider` and `getProvider` construct it.
class OtelProviderImpl implements OtelProvider {
    readonly tracer: Tracer;
    readonly meter: Meter;
    readonly logger: Logger;

    private traceProvider?: NodeTracerProvider;
    private meterProvider?: MeterProvider;
    private loggerProvider?: LoggerProvider;

    // The API keeps one registration per slot and refuses a second one without
    // throwing, so a slot already taken by the host application stays theirs.
    // Only the slots this instance actually obtained are released on shutdown.
    private readonly ownedSlots = new Set<GlobalSlot>();

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
        let traceExporter: OTLPTraceExporterHTTP | OTLPTraceExporterProto | OTLPTraceExporterGRPC | ConsoleSpanExporter;
        if (this.settings.traces === ExporterType.OTLP_HTTP) {
            traceExporter = new OTLPTraceExporterHTTP(getHttpExporterOptions(this.collectorOptions, "TRACES"));
        } else if (this.settings.traces === ExporterType.OTLP_HTTP_PROTOBUF) {
            traceExporter = new OTLPTraceExporterProto(getHttpExporterOptions(this.collectorOptions, "TRACES"));
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

        this.registerTracing(this.traceProvider);

        return this.traceProvider.getTracer(this.serviceName, this.serviceVersion);
    }

    /**
     * Registers the tracer provider, an async-local context manager and the
     * W3C trace-context and baggage propagators, as `NodeTracerProvider.register()`
     * does, but remembers which of the three slots this instance obtained.
     */
    private registerTracing(tracerProvider: NodeTracerProvider): void {
        if (trace.setGlobalTracerProvider(tracerProvider)) {
            this.ownedSlots.add("trace");
        }

        const contextManager = new AsyncLocalStorageContextManager();
        contextManager.enable();
        if (context.setGlobalContextManager(contextManager)) {
            this.ownedSlots.add("context");
        } else {
            contextManager.disable();
        }

        const propagator = new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] });
        if (propagation.setGlobalPropagator(propagator)) {
            this.ownedSlots.add("propagation");
        }
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
        let metricExporter: OTLPMetricExporterHTTP | OTLPMetricExporterProto | OTLPMetricExporterGRPC | ConsoleMetricExporter;
        if (this.settings.metrics === ExporterType.OTLP_HTTP) {
            metricExporter = new OTLPMetricExporterHTTP(getHttpExporterOptions(this.collectorOptions, "METRICS"));
        } else if (this.settings.metrics === ExporterType.OTLP_HTTP_PROTOBUF) {
            metricExporter = new OTLPMetricExporterProto(getHttpExporterOptions(this.collectorOptions, "METRICS"));
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

        if (metrics.setGlobalMeterProvider(this.meterProvider)) {
            this.ownedSlots.add("metrics");
        }

        // Taken from this instance's own provider, not from the global one: when
        // the global slot belongs to someone else the global meter would export
        // to their provider and ignore the exporter configured here.
        return this.meterProvider.getMeter(this.serviceName, this.serviceVersion);
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
        let logExporter: OTLPLogExporterHTTP | OTLPLogExporterProto | OTLPLogExporterGRPC | ConsoleLogRecordExporter;
        if (this.settings.logs === ExporterType.OTLP_HTTP) {
            logExporter = new OTLPLogExporterHTTP(getHttpExporterOptions(this.collectorOptions, "LOGS"));
        } else if (this.settings.logs === ExporterType.OTLP_HTTP_PROTOBUF) {
            logExporter = new OTLPLogExporterProto(getHttpExporterOptions(this.collectorOptions, "LOGS"));
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

        // Unlike the other setters this one returns the registered provider, and
        // when the slot is taken that is the previous owner's, not this one.
        if (logs.setGlobalLoggerProvider(this.loggerProvider) === this.loggerProvider) {
            this.ownedSlots.add("logs");
        }

        return this.loggerProvider.getLogger(this.serviceName, this.serviceVersion);
    }

    /**
     * Stops the three signals independently, so one failing exporter does not
     * leave the others unflushed, then releases the registrations this instance
     * took. The release happens after every signal has stopped: spans ended
     * during the flush still need the context manager. A single failure is
     * rethrown as it is, several are combined in an `AggregateError`.
     */
    async shutdown(): Promise<void> {
        console.debug("OTel provider shutdown...");
        const outcomes = await Promise.allSettled([this.traceProvider?.shutdown(), this.meterProvider?.shutdown(), this.loggerProvider?.shutdown()]);
        this.releaseSlots();

        const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, "OpenTelemetry provider shutdown failed for more than one signal");
        }
    }

    private releaseSlots(): void {
        if (this.ownedSlots.has("trace")) trace.disable();
        if (this.ownedSlots.has("context")) context.disable();
        if (this.ownedSlots.has("propagation")) propagation.disable();
        if (this.ownedSlots.has("metrics")) metrics.disable();
        if (this.ownedSlots.has("logs")) logs.disable();
        this.ownedSlots.clear();
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
        provider = new OtelProviderImpl(options);
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
        provider = new OtelProviderImpl();
    }
    return provider;
}

/**
 * Gracefully shutdown the provider and release resources.
 *
 * After shutdown, subsequent calls to {@link getProvider} will create
 * a fresh provider. If no provider exists, this is a no-op.
 *
 * The provider is released whether stopping succeeds or fails: when an
 * exporter cannot deliver its last batch (for example an unreachable
 * collector) the returned promise rejects, yet the next {@link getProvider}
 * starts from a clean state and a repeated call is a no-op. Every signal is
 * stopped even if another one fails, and the OpenTelemetry API global
 * registrations this provider took are released; a registration that belonged
 * to other code is left alone. Interceptors created earlier keep working: they
 * record into whichever provider is current.
 *
 * @throws The failure of the one signal that could not stop, or an
 * `AggregateError` carrying the failures when several could not
 */
export async function shutdownProvider(): Promise<void> {
    if (provider === undefined) {
        return;
    }
    const stopping = provider;
    // Cleared whatever the outcome: a provider whose shutdown failed is
    // half-stopped, and handing it out again would send telemetry nowhere.
    provider = undefined;
    await stopping.shutdown();
}
