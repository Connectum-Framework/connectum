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

import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, type MetricData, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
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

/**
 * Build a stable sort key from an attributes record by serializing the
 * already-sorted `Object.keys()` entries. `normalizeAttributes` returns keys
 * in alphabetical order, so `JSON.stringify` here is deterministic.
 */
function attrsKey(attrs: Record<string, unknown>): string {
    return JSON.stringify(attrs);
}

function normalizeSpan(span: ReadableSpan): NormalizedSpan {
    // Sort events by (name, serialized attributes) so that handlers/interceptors
    // emitting events in non-deterministic order (Promise.all, concurrent
    // probes, etc.) do not produce a flaky structural diff.
    const events = span.events
        .map((e) => ({
            name: e.name,
            attributes: normalizeAttributes(e.attributes as Record<string, unknown> | undefined, TRANSPORT_SPAN_ATTRIBUTE),
        }))
        .sort((a, b) => {
            if (a.name !== b.name) return a.name < b.name ? -1 : 1;
            const ak = attrsKey(a.attributes);
            const bk = attrsKey(b.attributes);
            return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
    return {
        name: span.name,
        kind: span.kind,
        attributes: normalizeAttributes(span.attributes as Record<string, unknown>, TRANSPORT_SPAN_ATTRIBUTE),
        events,
        status: { code: span.status.code, message: span.status.message },
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
    };
}

function normalizeMetric(md: MetricData): NormalizedMetric {
    // Sort data points by serialized attributes — `dataPoints` order from the
    // SDK is implementation-defined and not stable across transports.
    const points = md.dataPoints
        .map((p) => ({
            attributes: normalizeAttributes(p.attributes as Record<string, unknown>, TRANSPORT_METRIC_ATTRIBUTE),
            value: p.value,
        }))
        .sort((a, b) => {
            const ak = attrsKey(a.attributes);
            const bk = attrsKey(b.attributes);
            return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
    return {
        name: md.descriptor.name,
        description: md.descriptor.description,
        unit: md.descriptor.unit,
        type: String(md.dataPointType),
        points,
    };
}

/**
 * Sort key for a normalized span — name + kind + serialized (sorted) attributes.
 * Sufficient to disambiguate the spans we emit in parity scenarios.
 */
function spanSortKey(s: NormalizedSpan): string {
    return `${s.name}\0${s.kind}\0${attrsKey(s.attributes)}`;
}

/**
 * In-memory span collector. Owns its own `BasicTracerProvider` so that
 * different scenarios cannot cross-contaminate.
 *
 * The provider is not registered globally. Callers that need
 * `trace.getTracer(...)` to resolve here should pass `collector.provider` to
 * `trace.setGlobalTracerProvider()` from `@opentelemetry/api`, and when done
 * call `trace.disable()` (which removes the global registration) before
 * {@link InMemorySpanCollector.dispose}.
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

    /**
     * Returns normalized finished spans collected so far.
     *
     * Spans are sorted by `(name, kind, sorted-attributes)` so that scenarios
     * which emit multiple spans concurrently produce a deterministic order
     * for the parity structural diff.
     */
    flush(): NormalizedSpan[] {
        return this.exporter
            .getFinishedSpans()
            .map(normalizeSpan)
            .sort((a, b) => {
                const ak = spanSortKey(a);
                const bk = spanSortKey(b);
                return ak < bk ? -1 : ak > bk ? 1 : 0;
            });
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
        // DELTA: each export carries only what was recorded since the previous
        // export. The parity driver does not care which temporality is used, only
        // that both transports use the same.
        this.exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
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
        // Sort by metric name so that the parity diff is order-independent
        // across transports (the SDK does not guarantee iteration order).
        out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return out;
    }

    reset(): void {
        this.exporter.reset();
    }

    async dispose(): Promise<void> {
        await this.provider.shutdown();
    }
}
