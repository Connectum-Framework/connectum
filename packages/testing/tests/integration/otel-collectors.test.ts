/**
 * The in-memory OpenTelemetry collectors are the measuring instrument of the
 * cross-transport parity driver: if they leak the transport marker, reorder
 * data differently per run, or share state between collectors, a parity diff
 * either fails for the wrong reason or hides a real divergence. These tests
 * drive each collector with instruments whose recorded values are known, and
 * check what `flush()` reports against those values.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { DataPointType } from "@opentelemetry/sdk-metrics";
import { InMemoryMetricCollector, InMemorySpanCollector } from "../../src/otel-collectors.ts";

describe("InMemorySpanCollector", () => {
    it("reports a finished span's name, kind, attributes and status, without the transport attribute", async () => {
        const collector = new InMemorySpanCollector();
        try {
            const span = collector.provider.getTracer("test").startSpan("echo.v1.EchoService/Echo", {
                kind: SpanKind.SERVER,
                attributes: { "rpc.method": "Echo", "connectum.transport": "http" },
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
            span.end();

            const flushed = collector.flush();

            assert.strictEqual(flushed.length, 1);
            const [reported] = flushed;
            assert.strictEqual(reported?.name, "echo.v1.EchoService/Echo");
            assert.strictEqual(reported?.kind, SpanKind.SERVER);
            assert.deepStrictEqual(reported?.attributes, { "rpc.method": "Echo" }, "the transport attribute is stripped, every other attribute is kept");
            assert.deepStrictEqual(reported?.status, { code: SpanStatusCode.ERROR, message: "boom" });
            assert.strictEqual(reported?.traceId, span.spanContext().traceId, "identifiers are kept raw for callers to mask");
            assert.strictEqual(reported?.spanId, span.spanContext().spanId);
        } finally {
            await collector.dispose();
        }
    });

    it("does not report a span that has not ended", async () => {
        const collector = new InMemorySpanCollector();
        try {
            const open = collector.provider.getTracer("test").startSpan("still-open");
            assert.deepStrictEqual(collector.flush(), []);
            open.end();
            assert.deepStrictEqual(
                collector.flush().map((s) => s.name),
                ["still-open"],
            );
        } finally {
            await collector.dispose();
        }
    });

    it("strips the transport attribute from span events and sorts events by name, then by attributes", async () => {
        const collector = new InMemorySpanCollector();
        try {
            const span = collector.provider.getTracer("test").startSpan("with-events");
            span.addEvent("zeta", { "event.n": 1 });
            span.addEvent("alpha", { "event.n": 2, "connectum.transport": "local" });
            span.addEvent("alpha", { "event.n": 1 });
            span.end();

            const events = collector.flush()[0]?.events;

            assert.deepStrictEqual(events, [
                { name: "alpha", attributes: { "event.n": 1 } },
                { name: "alpha", attributes: { "event.n": 2 } },
                { name: "zeta", attributes: { "event.n": 1 } },
            ]);
        } finally {
            await collector.dispose();
        }
    });

    it("orders spans by name regardless of the order in which they ended", async () => {
        const collector = new InMemorySpanCollector();
        try {
            const tracer = collector.provider.getTracer("test");
            const second = tracer.startSpan("b-second");
            const first = tracer.startSpan("a-first");
            second.end();
            first.end();

            assert.deepStrictEqual(
                collector.flush().map((s) => s.name),
                ["a-first", "b-second"],
            );
        } finally {
            await collector.dispose();
        }
    });

    it("names the parent of a child span and leaves a root span without one", async () => {
        const collector = new InMemorySpanCollector();
        try {
            const tracer = collector.provider.getTracer("test");
            const parent = tracer.startSpan("parent");
            const child = tracer.startSpan("child", {}, trace.setSpan(context.active(), parent));
            child.end();
            parent.end();

            const byName = new Map(collector.flush().map((s) => [s.name, s]));
            assert.strictEqual(byName.get("parent")?.parentSpanId, undefined);
            assert.strictEqual(byName.get("child")?.parentSpanId, parent.spanContext().spanId);
            assert.strictEqual(byName.get("child")?.traceId, parent.spanContext().traceId);
        } finally {
            await collector.dispose();
        }
    });

    it("forgets everything on reset()", async () => {
        const collector = new InMemorySpanCollector();
        try {
            collector.provider.getTracer("test").startSpan("gone").end();
            assert.strictEqual(collector.flush().length, 1);
            collector.reset();
            assert.deepStrictEqual(collector.flush(), []);
        } finally {
            await collector.dispose();
        }
    });

    it("keeps collectors isolated from each other", async () => {
        const first = new InMemorySpanCollector();
        const second = new InMemorySpanCollector();
        try {
            first.provider.getTracer("test").startSpan("only-in-first").end();
            assert.deepStrictEqual(second.flush(), [], "a span recorded through one collector must not reach another");
            assert.strictEqual(first.flush().length, 1);
        } finally {
            await first.dispose();
            await second.dispose();
        }
    });
});

describe("InMemoryMetricCollector", () => {
    it("reports a counter's name, description, unit, type and summed value, without the transport label", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            const counter = collector.provider.getMeter("test").createCounter("rpc.calls", { description: "calls served", unit: "{call}" });
            counter.add(2, { method: "Echo", transport: "http" });
            counter.add(3, { method: "Echo", transport: "http" });

            const flushed = await collector.flush();

            assert.deepStrictEqual(flushed, [
                {
                    name: "rpc.calls",
                    description: "calls served",
                    unit: "{call}",
                    type: String(DataPointType.SUM),
                    points: [{ attributes: { method: "Echo" }, value: 5 }],
                },
            ]);
        } finally {
            await collector.dispose();
        }
    });

    it("reports one point per label set, ordered by label set, and metrics ordered by name", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            const meter = collector.provider.getMeter("test");
            const zeta = meter.createCounter("z.metric");
            const alpha = meter.createCounter("a.metric");
            zeta.add(1, { method: "Echo" });
            alpha.add(7, { method: "SecureEcho" });
            alpha.add(4, { method: "Echo" });

            const flushed = await collector.flush();

            assert.deepStrictEqual(
                flushed.map((m) => m.name),
                ["a.metric", "z.metric"],
            );
            assert.deepStrictEqual(flushed[0]?.points, [
                { attributes: { method: "Echo" }, value: 4 },
                { attributes: { method: "SecureEcho" }, value: 7 },
            ]);
        } finally {
            await collector.dispose();
        }
    });

    it("removes the transport label from every point, even when it was the only difference between two points", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            const counter = collector.provider.getMeter("test").createCounter("rpc.calls");
            counter.add(1, { method: "Echo", transport: "http" });
            counter.add(1, { method: "Echo", transport: "local" });

            const points = (await collector.flush())[0]?.points;

            // Two raw points, one per transport, both reduced to the same label set: the
            // parity diff compares label sets, so the marker must not survive.
            assert.deepStrictEqual(points, [
                { attributes: { method: "Echo" }, value: 1 },
                { attributes: { method: "Echo" }, value: 1 },
            ]);
        } finally {
            await collector.dispose();
        }
    });

    it("reports nothing after reset() and for a meter that recorded nothing", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            assert.deepStrictEqual(await collector.flush(), []);
            collector.provider.getMeter("test").createCounter("rpc.calls").add(1);
            assert.strictEqual((await collector.flush()).length, 1);
            collector.reset();
            assert.deepStrictEqual(await collector.flush(), []);
        } finally {
            await collector.dispose();
        }
    });

    it("reports only what was recorded since the previous flush()", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            const hits = collector.provider.getMeter("test").createCounter("hits");
            const valuesOf = (flushed: Awaited<ReturnType<InMemoryMetricCollector["flush"]>>) => flushed.map((m) => [m.name, m.points.map((p) => p.value)]);

            hits.add(1);
            assert.deepStrictEqual(valuesOf(await collector.flush()), [["hits", [1]]]);

            hits.add(5);
            assert.deepStrictEqual(valuesOf(await collector.flush()), [["hits", [5]]], "the second flush must not repeat the first one's export");

            assert.deepStrictEqual(await collector.flush(), [], "a flush with nothing recorded in between reports nothing");
        } finally {
            await collector.dispose();
        }
    });

    it("lets find() by name see the current value after a later flush()", async () => {
        const collector = new InMemoryMetricCollector();
        try {
            const hits = collector.provider.getMeter("test").createCounter("hits");
            hits.add(1);
            await collector.flush();
            hits.add(5);

            const current = (await collector.flush()).find((m) => m.name === "hits");

            assert.deepStrictEqual(current?.points, [{ attributes: {}, value: 5 }]);
        } finally {
            await collector.dispose();
        }
    });

    it("rejects flush() after dispose() and still allows dispose() to be called again", async () => {
        const collector = new InMemoryMetricCollector();
        collector.provider.getMeter("test").createCounter("hits").add(1);
        await collector.flush();
        await collector.dispose();

        await assert.rejects(collector.flush(), /flush\(\) called after dispose\(\)/);
        await assert.doesNotReject(collector.dispose());
    });

    it("keeps collectors isolated from each other", async () => {
        const first = new InMemoryMetricCollector();
        const second = new InMemoryMetricCollector();
        try {
            first.provider.getMeter("test").createCounter("only.in.first").add(1);
            assert.deepStrictEqual(await second.flush(), [], "a metric recorded through one collector must not reach another");
            assert.strictEqual((await first.flush()).length, 1);
        } finally {
            await first.dispose();
            await second.dispose();
        }
    });
});
