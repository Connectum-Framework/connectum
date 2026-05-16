/**
 * In-memory OpenTelemetry collectors for cross-transport parity testing.
 *
 * Provides {@link InMemorySpanCollector} and {@link InMemoryMetricCollector} —
 * lightweight wrappers around the official SDK in-memory exporters with
 * `flush()` helpers that return a normalized, transport-agnostic shape.
 *
 * "Normalized" here means:
 *   - the `connectum.transport` span attribute is stripped (it intentionally
 *     differs between HTTP and in-process paths and would defeat parity diff);
 *   - the `transport` metric attribute is stripped for the same reason;
 *   - identifiers that legitimately differ between independent runs
 *     (`traceId`, `spanId`, `parentSpanId`, wall-clock timestamps) are
 *     preserved in the raw output so callers performing structural diff
 *     can mask them as needed (the default driver compare strips them).
 *
 * Each scenario must use a *fresh* collector pair, otherwise the second
 * transport will observe spans/metrics emitted by the first.
 *
 * @module otel-collectors
 */

import { InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Span attribute key produced by `@connectum/otel` to distinguish transports. */
export const TRANSPORT_SPAN_ATTRIBUTE = "connectum.transport";
/** Metric attribute key produced by `@connectum/otel` to distinguish transports. */
export const TRANSPORT_METRIC_ATTRIBUTE = "transport";

/**
 * Structural, transport-agnostic representation of a span suitable for `deepEqual`.
 */
export interface NormalizedSpan {
    name: string;
    kind: number;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown> }>;
    status: { code: number; message: string | undefined };
    traceId: string;
    spanId: string;
    parentSpanId: string | undefined;
}

/**
 * Structural representation of a single metric data point.
 */
export interface NormalizedMetric {
    name: string;
    description: string;
    unit: string;
    type: string;
    points: Array<{
        attributes: Record<string, unknown>;
        value: unknown;
    }>;
}

function normalizeAttributes(attrs: Record<string, unknown> | undefined, dropKey: string): Record<string, unknown> {
    if (!attrs) {
        return {};
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(attrs).sort()) {
        if (k === dropKey) {
            continue;
        }
        out[k] = attrs[k];
    }
    return out;
}

function normalizeSpan(span: ReadableSpan): NormalizedSpan {
    return {
        name: span.name,
        kind: span.kind,
        attributes: normalizeAttributes(span.attributes as Record<string, unknown>, TRANSPORT_SPAN_ATTRIBUTE),
        events: span.events.map((e) => ({
            name: e.name,
            attributes: normalizeAttributes(e.attributes as Record<string, unknown> | undefined, TRANSPORT_SPAN_ATTRIBUTE),
        })),
        status: { code: span.status.code, message: span.status.message },
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
    };
}

function normalizeMetric(md: MetricData): NormalizedMetric {
    return {
        name: md.descriptor.name,
        description: md.descriptor.description,
        unit: md.descriptor.unit,
        type: String(md.dataPointType),
        points: md.dataPoints.map((p) => ({
            attributes: normalizeAttributes(p.attributes as Record<string, unknown>, TRANSPORT_METRIC_ATTRIBUTE),
            value: p.value,
        })),
    };
}

/**
 * In-memory span collector. Owns its own `BasicTracerProvider` so that
 * different scenarios cannot cross-contaminate.
 *
 * Callers wishing to register the provider globally (so that
 * `trace.getTracer(...)` resolves here) should call {@link registerGlobal}
 * — and pair it with {@link InMemorySpanCollector.dispose} when done.
 */
export class InMemorySpanCollector {
    public readonly exporter: InMemorySpanExporter;
    public readonly provider: BasicTracerProvider;

    constructor() {
        this.exporter = new InMemorySpanExporter();
        this.provider = new BasicTracerProvider({
            spanProcessors: [new SimpleSpanProcessor(this.exporter)],
        });
    }

    /** Returns normalized finished spans collected so far. */
    flush(): NormalizedSpan[] {
        return this.exporter.getFinishedSpans().map(normalizeSpan);
    }

    /** Clear the internal buffer. */
    reset(): void {
        this.exporter.reset();
    }

    async dispose(): Promise<void> {
        await this.provider.shutdown();
    }
}

/**
 * In-memory metric collector. Owns its own `MeterProvider` and periodic
 * reader. `flush()` performs a forced collect+export cycle synchronously
 * (via `forceFlush`) and returns the normalized data.
 */
export class InMemoryMetricCollector {
    public readonly exporter: InMemoryMetricExporter;
    public readonly provider: MeterProvider;
    public readonly reader: PeriodicExportingMetricReader;

    constructor() {
        // `0` aggregation temporality = CUMULATIVE; the parity driver
        // does not care which one, only that both transports use the same.
        this.exporter = new InMemoryMetricExporter(0);
        this.reader = new PeriodicExportingMetricReader({
            exporter: this.exporter,
            // long interval — we force-flush manually.
            exportIntervalMillis: 60_000,
        });
        this.provider = new MeterProvider({ readers: [this.reader] });
    }

    async flush(): Promise<NormalizedMetric[]> {
        await this.reader.forceFlush();
        const resourceMetrics = this.exporter.getMetrics();
        const out: NormalizedMetric[] = [];
        for (const rm of resourceMetrics) {
            for (const sm of rm.scopeMetrics) {
                for (const md of sm.metrics) {
                    out.push(normalizeMetric(md));
                }
            }
        }
        return out;
    }

    reset(): void {
        this.exporter.reset();
    }

    async dispose(): Promise<void> {
        await this.provider.shutdown();
    }
}
