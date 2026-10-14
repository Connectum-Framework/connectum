/**
 * Telemetry observation for interceptor tests.
 *
 * Runs a body against fresh in-memory tracer and meter providers installed as the
 * OpenTelemetry globals, together with the W3C Trace Context propagator, and returns
 * what was recorded. Everything global is reset before and after, so a test sees only
 * its own telemetry and leaves nothing behind.
 */

import assert from "node:assert";
import { InMemoryMetricCollector, InMemorySpanCollector, type NormalizedMetric, type NormalizedSpan } from "@connectum/testing";
import { metrics as metricsApi, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { shutdownProvider } from "../../src/provider.ts";

/** Histogram data point as the SDK exports it. */
export interface HistogramValue {
    sum: number;
    count: number;
}

export interface Observed {
    spans: NormalizedSpan[];
    metrics: NormalizedMetric[];
    /** Span links by span id: the remote contexts a span was linked to rather than parented by. */
    links: Record<string, Array<{ traceId: string; spanId: string }>>;
}

export async function observe(body: () => Promise<void>): Promise<Observed> {
    const spanCollector = new InMemorySpanCollector();
    const metricCollector = new InMemoryMetricCollector();
    await shutdownProvider();
    trace.disable();
    metricsApi.disable();
    propagation.disable();
    trace.setGlobalTracerProvider(spanCollector.provider);
    metricsApi.setGlobalMeterProvider(metricCollector.provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    try {
        await body();
        const links: Observed["links"] = {};
        for (const span of spanCollector.exporter.getFinishedSpans()) {
            links[span.spanContext().spanId] = span.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId }));
        }
        const spans = spanCollector.flush();
        const metrics = await metricCollector.flush();
        return { spans, metrics, links };
    } finally {
        await shutdownProvider();
        trace.disable();
        metricsApi.disable();
        propagation.disable();
        await spanCollector.dispose();
        await metricCollector.dispose();
    }
}

/** Data points of one metric: the attributes and the recorded value of each. */
export function pointsOf(observed: Observed, metricName: string): Array<{ attributes: Record<string, unknown>; value: unknown }> {
    return observed.metrics.find((m) => m.name === metricName)?.points ?? [];
}

/** Attributes of every recorded data point of one metric. */
export function pointAttributes(observed: Observed, metricName: string): Array<Record<string, unknown>> {
    return pointsOf(observed, metricName).map((p) => p.attributes);
}

/** Sum and count of all histogram points of one metric, across attribute sets. */
export function histogramTotals(observed: Observed, metricName: string): HistogramValue {
    let sum = 0;
    let count = 0;
    for (const point of pointsOf(observed, metricName)) {
        const value = point.value as HistogramValue;
        sum += value.sum;
        count += value.count;
    }
    return { sum, count };
}

/** The one span of a call; fails with a readable message otherwise. */
export function onlySpan(observed: Observed): NormalizedSpan {
    assert.strictEqual(observed.spans.length, 1, `expected exactly one span, got ${observed.spans.map((s) => s.name).join(", ") || "none"}`);
    return observed.spans[0] as NormalizedSpan;
}
