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
import { ExporterType, getBatchSpanProcessorOptions, getCollectorOptions, getGrpcExporterOptions, getHttpExporterOptions, getOTLPSettings, getServiceMetadata } from "./config.ts";

/** OpenTelemetry semconv key for the service instance id. */
const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";

/**
 * Options for initializing the OpenTelemetry provider
 */
export interface ProviderOptions {
    /** Override service name (defaults to OTEL_SERVICE_NAME, then service.name in OTEL_RESOURCE_ATTRIBUTES, then npm_package_name) */
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
    /**
     * Override the exporter of a signal (defaults to the environment, see
     * {@link getOTLPSettings}). `initProvider()` throws `TypeError` for a key other
     * than `traces`, `metrics` or `logs` and for a value that is not an
     * {@link ExporterType}; the bare `otlp` accepted by the environment variables is
     * not one, use `otlp/http-protobuf`. An entry that is absent or `undefined`
     * falls back to the environment.
     */
    settings?: Partial<OTLPSettings>;
}

/** Options of {@link shutdownProvider}. */
export interface ShutdownProviderOptions {
    /**
     * Longest time in milliseconds the call waits for the exporters to deliver what they
     * hold. When it passes, the call rejects with an error named `TimeoutError`. The
     * provider is released either way, and the exporters keep trying in the background
     * until their own timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`, 10 seconds by default) ends.
     * The OpenTelemetry API global registrations (tracer provider, context manager,
     * propagator, meter and logger provider) are released only when that stop ends, so a
     * provider created before then does not obtain them.
     * Must be a positive finite number. Without it the call waits as long as the
     * exporters need.
     */
    timeout?: number;
}

const SETTINGS_SIGNALS: readonly string[] = ["traces", "metrics", "logs"];
const SETTINGS_EXPORTERS: readonly string[] = Object.values(ExporterType);

/**
 * Throws `TypeError` for `settings` that name no signal or no exporter. The
 * environment variables are lenient because they are read inside the first
 * instrumented call; a value written in code is the programmer's and fails at once.
 */
function validateSettings(settings: unknown): void {
    if (settings === undefined) {
        return;
    }
    if (typeof settings !== "object" || settings === null) {
        throw new TypeError(`initProvider: settings must be an object with the keys ${SETTINGS_SIGNALS.join(", ")}, got ${JSON.stringify(settings)}.`);
    }
    for (const [signal, exporter] of Object.entries(settings)) {
        if (!SETTINGS_SIGNALS.includes(signal)) {
            throw new TypeError(`initProvider: unknown key ${JSON.stringify(signal)} in settings; expected ${SETTINGS_SIGNALS.join(", ")}.`);
        }
        if (exporter !== undefined && !SETTINGS_EXPORTERS.includes(exporter as string)) {
            throw new TypeError(`initProvider: settings.${signal} is ${JSON.stringify(exporter)}; expected one of ${SETTINGS_EXPORTERS.join(", ")}.`);
        }
    }
}

/**
 * Splits `key1=value1,key2=value2` on the raw `,` and the first `=`, trims the
 * whitespace around each part and percent-decodes it. Returns `undefined` when a
 * part is not valid percent-encoding.
 */
function readResourceAttributes(raw: string | undefined): Record<string, string> | undefined {
    if (raw === undefined || raw === "") {
        return {};
    }
    const result: Record<string, string> = {};
    try {
        for (const pair of raw.split(",")) {
            const eq = pair.indexOf("=");
            if (eq <= 0) {
                continue;
            }
            const key = decodeURIComponent(pair.slice(0, eq).trim());
            const value = decodeURIComponent(pair.slice(eq + 1).trim());
            if (key !== "") {
                result[key] = value;
            }
        }
    } catch {
        return undefined;
    }
    return result;
}

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` env var
 * (`key1=value1,key2=value2`) into an attribute record. Malformed pairs (no
 * `=`, empty key) are skipped. Values are kept as strings; whitespace around
 * keys and values is trimmed.
 *
 * Keys and values are percent-decoded, as the OpenTelemetry Resource SDK
 * specification requires: `,` and `=` inside a key or value are written `%2C` and
 * `%3D`. The text is split on the raw separators first, so an encoded comma stays
 * in its value; `+` is not a space. When a part is not valid percent-encoding the
 * whole variable is discarded: this returns `{}` and emits a process warning (code
 * `CONNECTUM_OTEL_INVALID_ENV`) naming the variable.
 */
export function parseOtelResourceAttributesEnv(raw: string | undefined): Record<string, string> {
    const attributes = readResourceAttributes(raw);
    if (attributes === undefined) {
        process.emitWarning(`OTEL_RESOURCE_ATTRIBUTES="${raw}" is not valid percent-encoding; the whole variable is ignored.`, { code: "CONNECTUM_OTEL_INVALID_ENV" });
        return {};
    }
    return attributes;
}

/** Inputs for {@link resolveServiceName}. */
export interface ServiceNameInputs {
    /** Name passed in code (`ProviderOptions.serviceName`). */
    explicit?: string | undefined;
    /** Environment source (defaults to `process.env`). */
    env?: { OTEL_SERVICE_NAME?: string; OTEL_RESOURCE_ATTRIBUTES?: string; npm_package_name?: string } | undefined;
}

/**
 * Resolve the `service.name` the provider reports.
 *
 * Precedence (highest first): the explicit `serviceName` option →
 * `OTEL_SERVICE_NAME` → `service.name` inside `OTEL_RESOURCE_ATTRIBUTES` →
 * `npm_package_name` → `"unknown-service"`. `OTEL_SERVICE_NAME` outranks the
 * resource-attributes entry, as the OpenTelemetry SDK environment-variable
 * specification requires. Empty values are treated as unset.
 */
export function resolveServiceName(inputs: ServiceNameInputs = {}): string {
    const env = inputs.env ?? process.env;
    return (
        nonEmpty(inputs.explicit) ??
        nonEmpty(env.OTEL_SERVICE_NAME) ??
        // Read silently: the same variable is read again, and reported, by buildResourceAttributes().
        nonEmpty(readResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES)?.[ATTR_SERVICE_NAME]) ??
        nonEmpty(env.npm_package_name) ??
        "unknown-service"
    );
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === "" ? undefined : value;
}

/** Inputs for {@link buildResourceAttributes}. */
export interface ResourceAttributeInputs {
    /** The final service name (see {@link resolveServiceName}); it is not overridden by `OTEL_RESOURCE_ATTRIBUTES`. */
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
 * Precedence (lowest to highest): `service.version` → env
 * (`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_INSTANCE_ID`) → explicit
 * `resourceAttributes` → explicit `instanceId`. `service.name` is the already
 * resolved `serviceName` and is never overridden by the env attributes.
 */
export function buildResourceAttributes(inputs: ResourceAttributeInputs): Record<string, string | number | boolean> {
    const env = inputs.env ?? process.env;

    const attributes: Record<string, string | number | boolean> = {
        [ATTR_SERVICE_VERSION]: inputs.serviceVersion,
        // Env-provided attributes (lower precedence than explicit options).
        ...parseOtelResourceAttributesEnv(env.OTEL_RESOURCE_ATTRIBUTES),
        [ATTR_SERVICE_NAME]: inputs.serviceName,
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
        this.serviceName = resolveServiceName({ explicit: options?.serviceName });
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
            traceExporter = new OTLPTraceExporterGRPC(getGrpcExporterOptions(this.collectorOptions, "TRACES"));
        } else {
            // `console`: the only value left once the settings have been resolved and validated
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
            metricExporter = new OTLPMetricExporterGRPC(getGrpcExporterOptions(this.collectorOptions, "METRICS"));
        } else {
            // `console`: the only value left once the settings have been resolved and validated
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
            logExporter = new OTLPLogExporterGRPC(getGrpcExporterOptions(this.collectorOptions, "LOGS"));
        } else {
            // `console`: the only value left once the settings have been resolved and validated
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

// Stops that have not settled yet. The provider reference is cleared when a stop
// starts, so without this a second call would see nothing to stop and return before
// the first call's flush had finished.
const stopping = new Set<Promise<void>>();

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
 * @throws TypeError when `options.settings` names a signal or an exporter that
 * does not exist. The check runs before anything is created, also when a provider
 * already exists and the options would otherwise be ignored.
 */
export function initProvider(options?: ProviderOptions): void {
    validateSettings(options?.settings);
    if (provider === undefined) {
        provider = new OtelProviderImpl(options);
    }
}

/**
 * Whether a provider exists, without creating one. The provider registers the
 * OpenTelemetry diagnostics logger when it is created, so code that wants to report
 * through `diag` can tell whether the report would be seen.
 *
 * @internal
 */
export function hasProvider(): boolean {
    return provider !== undefined;
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
 * A call made while another call is still stopping a provider waits for that stop
 * too and settles with the same outcome, so two independent shutdown hooks cannot
 * race ahead of the flush. Once the stop has settled, a further call is a no-op.
 *
 * The wait is bounded by the exporters (`OTEL_EXPORTER_OTLP_TIMEOUT`, 10 seconds
 * by default, per export). Pass `timeout` to bound it to what the surrounding shutdown
 * allows; see {@link ShutdownProviderOptions.timeout}.
 *
 * @param options - Optional deadline for this call
 * @throws The failure of the one signal that could not stop, or an
 * `AggregateError` carrying the failures when several could not
 * @throws An error named `TimeoutError` when `options.timeout` passed first
 * @throws TypeError when `options.timeout` is not a positive finite number
 */
export async function shutdownProvider(options?: ShutdownProviderOptions): Promise<void> {
    const timeout = options?.timeout;
    if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
        throw new TypeError(`shutdownProvider: timeout must be a positive finite number of milliseconds, got ${String(timeout)}.`);
    }
    if (provider !== undefined) {
        const current = provider;
        // Cleared whatever the outcome: a provider whose shutdown failed is
        // half-stopped, and handing it out again would send telemetry nowhere.
        provider = undefined;
        const run: Promise<void> = current.shutdown().finally(() => stopping.delete(run));
        stopping.add(run);
    }
    if (stopping.size === 0) {
        return;
    }
    // Every stop is awaited before the first failure is rethrown: a hook that exits the process must
    // not run while a later stop is still flushing.
    const settled = Promise.allSettled([...stopping]).then((outcomes) => {
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") {
                throw outcome.reason;
            }
        }
    });
    await (timeout === undefined ? settled : withDeadline(settled, timeout));
}

/** Rejects with a `TimeoutError` when `work` has not settled within `timeout` milliseconds. */
function withDeadline(work: Promise<void>, timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`OpenTelemetry provider shutdown did not finish within ${timeout} ms.`);
            error.name = "TimeoutError";
            reject(error);
        }, timeout);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
