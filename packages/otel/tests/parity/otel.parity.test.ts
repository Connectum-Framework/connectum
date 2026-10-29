/**
 * OpenTelemetry tracing & metrics parity for in-process transport.
 *
 * Asserts that `@connectum/otel` produces structurally identical OTel spans
 * and metric instruments across HTTP and in-process transports. The only
 * permitted differences are the `connectum.transport` span attribute and
 * the `transport` metric label (both stripped by the parity collectors
 * before structural diff).
 *
 *   unary → CLIENT + SERVER spans, parent-child, identical attrs
 *   streaming → N `rpc.message` SENT / N RECEIVED events
 *   error case → span status=ERROR, rpc.response.status_code matches
 *   metrics — identical instrument names, label keys, observable shape
 *   context propagation — server span is child of client span
 *   instrument-name subset (no transport-specific metrics)
 *
 * The OTel global tracer/meter providers are swapped per-scenario so each
 * run writes to its own in-memory collector and the parity driver can diff
 * normalised outputs deterministically.
 *
 * Test prereq: env vars `OTEL_*_EXPORTER=none` are set at module load so that
 * `@connectum/otel`'s lazy `OtelProvider` does not try to spawn an OTLP
 * exporter (which would override our global providers).
 */

// MUST run before any @connectum/otel import resolves transitively.
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { context, metrics as metricsApi, propagation, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { DataPointType } from "@opentelemetry/sdk-metrics";

import { ATTR_CONNECTUM_TRANSPORT, ATTR_CONNECTUM_TRANSPORT_METRIC } from "../../src/attributes.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// Register an AsyncLocalStorage-backed context manager once at module load.
// `BasicTracerProvider` (used by our in-memory collectors) does not register
// one, so without this `context.with()` and `context.active()` are no-ops —
// which breaks W3C trace-context propagation.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

// `propagation.inject()` / `extract()` are no-ops until a propagator is
// registered. Without this, `traceparent` headers would never be emitted on
// the HTTP path, and the server-side interceptor's `trustRemote: true`
// would have nothing to extract — leaving HTTP and in-process paths with
// different parent-child shapes.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// In-memory OTel collectors come from `@connectum/testing` — they own the
// normalisation logic (stripping `connectum.transport` / `transport` keys)
// shared with every other parity test under `packages/testing/tests/parity`.
import { InMemoryMetricCollector, InMemorySpanCollector, type NormalizedMetric, type NormalizedSpan } from "@connectum/testing";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";

// ---------------------------------------------------------------------------
// Service routes
// ---------------------------------------------------------------------------

function echoRoutes(opts?: { throwError?: boolean }) {
    return defineService(EchoService, {
        echo: (req) => {
            if (opts?.throwError) {
                throw new ConnectError("forced failure", Code.FailedPrecondition);
            }
            return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
        },
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

function streamingRoutes() {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server(req) {
            const n = req.sequence || 3;
            for (let i = 0; i < n; i++) {
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
            }
        },
        async client(requests) {
            let total = 0;
            for await (const _ of requests) total++;
            return { total };
        },
        async *bidi(requests) {
            for await (const item of requests) yield create(ItemSchema, { value: item.value, sequence: item.sequence });
        },
    });
}

// ---------------------------------------------------------------------------
// Per-scenario OTel harness
// ---------------------------------------------------------------------------

/**
 * Installs fresh in-memory tracer + meter providers as the OTel globals,
 * runs the body, then disposes the providers. Returns the spans/metrics
 * normalised (with `connectum.transport` / `transport` stripped).
 *
 * Each transport-run gets its own harness so the collectors never
 * cross-contaminate between the HTTP and local invocations.
 */
async function withOtelHarness(body: () => Promise<void>): Promise<{ spans: NormalizedSpan[]; metrics: NormalizedMetric[] }> {
    const spans = new InMemorySpanCollector();
    const metrics = new InMemoryMetricCollector();
    // `setGlobalTracerProvider` (and the meter equivalent) silently refuse to
    // overwrite an already-registered provider, emitting a console warning.
    // We must call `disable()` first so each scenario starts with a clean
    // slate — otherwise the second scenario's collector never sees any spans
    // (the first scenario's provider stays bound to the global delegate).
    // Tear down any cached `@connectum/otel` provider from previous scenarios
    // — its `tracer` / `meter` were captured against the *previous* global
    // tracer provider, which is about to be replaced. Without this, the
    // OTel server interceptor would keep emitting spans into the prior
    // scenario's exporter (which has already been disposed).
    await shutdownProvider();
    trace.disable();
    metricsApi.disable();
    trace.setGlobalTracerProvider(spans.provider);
    metricsApi.setGlobalMeterProvider(metrics.provider);
    try {
        await body();
        return { spans: spans.flush(), metrics: await metrics.flush() };
    } finally {
        await shutdownProvider();
        trace.disable();
        metricsApi.disable();
        await spans.dispose();
        await metrics.dispose();
    }
}

/**
 * Run a scenario against both an HTTP-bound and an in-process-bound server,
 * each behind a freshly initialised OTel harness. Returns the two
 * (spans, metrics) bundles so individual tests can diff exactly the shape
 * they care about.
 *
 * Server-side and client-side OTel interceptors are attached on both runs
 * — they must be the same factory output (the interceptors keep an internal
 * lazy `meter` cache; passing the same instance is fine because we swap
 * the global meter provider before each run).
 */
async function runBothTransports(opts: {
    services: Parameters<typeof createServer>[0]["services"];
    /**
     * Builds the (server-side, client-side) interceptors freshly for each
     * transport run. Required because `@connectum/otel` interceptors lazily
     * cache a `Meter`/`RpcServerMetrics` reference on first use — sharing
     * the same interceptor instance across runs would pin the metric
     * recordings to the *first* run's global meter provider.
     */
    buildInterceptors: () => { server: Interceptor; client: Interceptor };
    scenario: (transport: { fn: import("@connectrpc/connect").Transport }) => Promise<void>;
}): Promise<{
    http: { spans: NormalizedSpan[]; metrics: NormalizedMetric[] };
    local: { spans: NormalizedSpan[]; metrics: NormalizedMetric[] };
}> {
    // HTTP run — build a *fresh* interceptor pair pinned to this run's globals.
    const httpItcs = opts.buildInterceptors();
    const httpServer = createServer({
        services: opts.services,
        interceptors: [httpItcs.server],
        port: 0,
        allowHTTP1: false,
    });
    await httpServer.start();
    const httpPort = httpServer.address?.port;
    if (!httpPort) {
        await httpServer.stop();
        throw new Error("HTTP server failed to bind");
    }
    const http = await withOtelHarness(async () => {
        const transport = createGrpcTransport({
            baseUrl: `http://localhost:${httpPort}`,
            interceptors: [httpItcs.client],
        });
        await opts.scenario({ fn: transport });
    }).finally(async () => {
        await httpServer.stop();
    });

    // Local run — fresh interceptors (see comment above).
    const localItcs = opts.buildInterceptors();
    const localServer = createServer({
        services: opts.services,
        interceptors: [localItcs.server],
    });
    const local = await withOtelHarness(async () => {
        const transport = createLocalTransport(localServer, { interceptors: [localItcs.client] });
        await opts.scenario({ fn: transport });
    });

    return { http, local };
}

/**
 * Build the OTel interceptors used by every test: server + client. We pin
 * `serverAddress` to a stable value so the `server.address` attribute is
 * identical between HTTP and local (otherwise the HTTP run would see
 * `hostname()` and the local run might too, but better to be explicit).
 */
function buildOtelInterceptors(opts?: { trustRemote?: boolean }): { server: Interceptor; client: Interceptor } {
    // `trustRemote: true` is required for cross-transport parity: the
    // in-process pipe runs the server-side interceptor in the same async
    // context as the client interceptor, so without `trustRemote` the
    // server span would still inherit the client span as parent — while
    // the HTTP path would record only a *link* (no parent), producing a
    // structural diff that has nothing to do with the transport itself.
    // Defaulting to `trustRemote: true` aligns the two paths: the server
    // span uses the extracted trace context as its parent on both paths.
    const trustRemote = opts?.trustRemote ?? true;
    const server = createOtelInterceptor({
        serverAddress: "test-server",
        recordMessages: true,
        trustRemote,
    });
    const client = createOtelClientInterceptor({
        serverAddress: "test-server",
        recordMessages: true,
    });
    return { server, client };
}

// ---------------------------------------------------------------------------
// Helpers for span structural comparison
// ---------------------------------------------------------------------------

/**
 * Strip identifiers that legitimately differ between independent runs and
 * keep only the behavioural shape (kind, name, attributes, events, status,
 * hasParent). Mirrors `transportParityTest.defaultCompare`'s span mask.
 */
function maskSpans(spans: NormalizedSpan[]): unknown {
    return spans.map((s) => ({
        name: s.name,
        kind: s.kind,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        hasParent: s.parentSpanId !== undefined,
    }));
}

/**
 * Reduce a metric list to just (name, unit, type, set of label keys). This
 * is what the metric shape comparisons need: values from histogram timings differ run-to-run
 * (clock drift, payload size differences), so we cannot deep-compare data
 * points exactly.
 */
function metricShape(ms: NormalizedMetric[]): Array<{ name: string; unit: string; type: string; labelKeys: string[] }> {
    return ms
        .map((m) => ({
            name: m.name,
            unit: m.unit,
            type: m.type,
            labelKeys: Array.from(
                new Set(m.points.flatMap((p) => Object.keys(p.attributes))),
            ).sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Unary span parity
// ---------------------------------------------------------------------------

// The span name and `rpc.method` of a call are `<package>.<Service>/<Method>`
// (the metrics guide's attribute table), written out here rather than derived.
const ECHO_METHOD = "echo.v1.EchoService/Echo";

test("parity: unary RPC produces identical CLIENT+SERVER spans", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            await client.echo(create(EchoRequestSchema, { message: "hi" }));
        },
    });

    // Both runs must observe exactly one CLIENT and one SERVER span.
    const httpKinds = http.spans.map((s) => s.kind).sort();
    const localKinds = local.spans.map((s) => s.kind).sort();
    assert.deepStrictEqual(httpKinds, [SpanKind.SERVER, SpanKind.CLIENT].sort(), "HTTP run must produce CLIENT+SERVER span pair");
    assert.deepStrictEqual(localKinds, [SpanKind.SERVER, SpanKind.CLIENT].sort(), "Local run must produce CLIENT+SERVER span pair");

    // Each span carries the documented identity attributes. Comparing the two
    // transports alone would let a change made on both paths at once pass.
    for (const run of [http, local]) {
        for (const kind of [SpanKind.CLIENT, SpanKind.SERVER]) {
            const span = run.spans.find((s) => s.kind === kind);
            assert.ok(span, `span of kind ${kind} missing`);
            assert.strictEqual(span.name, ECHO_METHOD);
            assert.strictEqual(span.attributes["rpc.method"], ECHO_METHOD);
            assert.strictEqual(span.attributes["rpc.system.name"], "connectrpc");
            assert.strictEqual(span.attributes["server.address"], "test-server");
        }
    }

    // After stripping `connectum.transport` (done in normalizeSpan), the
    // structural shape must be identical.
    assert.deepStrictEqual(maskSpans(local.spans), maskSpans(http.spans), "span shape mismatch between transports (after stripping connectum.transport)");
});

// ---------------------------------------------------------------------------
// Streaming span events parity
// ---------------------------------------------------------------------------

test("parity: server-streaming emits identical rpc.message events", async () => {
    const { http, local } = await runBothTransports({
        services: [streamingRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(StreamingService, fn);
            const items: number[] = [];
            for await (const item of client.server(create(ItemSchema, { value: "s", sequence: 3 }))) {
                items.push(item.sequence);
            }
            assert.deepStrictEqual(items, [0, 1, 2]);
        },
    });

    // The OpenTelemetry RPC conventions: one `rpc.message` event per message, typed SENT or
    // RECEIVED, with ids from two counters (sent, received) that each start at 1. The
    // call sends one request and receives three items, so the server span holds the
    // mirror image of the client span. Parity alone would pass if neither path recorded anything.
    // The two directions interleave in a timing-dependent order, so each direction is
    // compared on its own, in message order.
    const expectedEvents = {
        [SpanKind.CLIENT]: { SENT: [1], RECEIVED: [1, 2, 3] },
        [SpanKind.SERVER]: { SENT: [1, 2, 3], RECEIVED: [1] },
    };
    for (const [label, run] of [["http", http], ["local", local]] as const) {
        for (const kind of [SpanKind.CLIENT, SpanKind.SERVER] as const) {
            const span = run.spans.find((s) => s.kind === kind);
            assert.ok(span, `[${label}] span of kind ${kind} missing`);
            assert.ok(
                span.events.every((e) => e.name === "rpc.message"),
                `[${label}] every event of the span of kind ${kind} is rpc.message`,
            );
            const idsOf = (type: string) => span.events.filter((e) => e.attributes["rpc.message.type"] === type).map((e) => e.attributes["rpc.message.id"]);
            assert.deepStrictEqual({ SENT: idsOf("SENT"), RECEIVED: idsOf("RECEIVED") }, expectedEvents[kind], `[${label}] rpc.message ids of the span of kind ${kind}`);
            assert.strictEqual(span.events.length, 4, `[${label}] no event other than the four messages on the span of kind ${kind}`);
        }
    }

    // Both runs: count of SENT and RECEIVED rpc.message events must match
    // and event sequencing must be identical.
    const httpEvents = http.spans.flatMap((s) => s.events.map((e) => ({ name: e.name, type: e.attributes["rpc.message.type"], id: e.attributes["rpc.message.id"] })));
    const localEvents = local.spans.flatMap((s) => s.events.map((e) => ({ name: e.name, type: e.attributes["rpc.message.type"], id: e.attributes["rpc.message.id"] })));
    assert.deepStrictEqual(localEvents, httpEvents, "rpc.message event shape mismatch between transports");

    // Structural shape parity (attributes minus transport)
    assert.deepStrictEqual(maskSpans(local.spans), maskSpans(http.spans), "streaming span shape mismatch");
});

// ---------------------------------------------------------------------------
// Error span parity
// ---------------------------------------------------------------------------

test("parity: error case → span status=ERROR identical on both transports", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes({ throwError: true })],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            await assert.rejects(() => client.echo(create(EchoRequestSchema, { message: "x" })), (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition);
        },
    });

    // Both runs must record ERROR status with matching rpc.response.status_code.
    for (const run of [http, local]) {
        const serverSpan = run.spans.find((s) => s.kind === SpanKind.SERVER);
        assert.ok(serverSpan, "server span missing");
        assert.strictEqual(serverSpan.status.code, 2 /* SpanStatusCode.ERROR */, "server span must be ERROR");
        assert.strictEqual(serverSpan.attributes["rpc.response.status_code"], "FAILED_PRECONDITION", "rpc.response.status_code mismatch");
        assert.strictEqual(serverSpan.attributes["error.type"], "FAILED_PRECONDITION", "error.type mismatch");
        assert.ok(!("rpc.connect_rpc.status_code" in serverSpan.attributes), "the replaced attribute must not be emitted");
    }

    // Strip `exception.stacktrace` event attributes before structural diff —
    // it embeds protocol-internal frames (protocol-grpc vs protocol-connect)
    // that legitimately differ between transports without affecting the
    // observable error shape (code, error.type, status).
    const dropStack = (spans: NormalizedSpan[]) =>
        spans.map((s) => ({
            ...s,
            events: s.events.map((e) => ({
                name: e.name,
                attributes: Object.fromEntries(Object.entries(e.attributes).filter(([k]) => k !== "exception.stacktrace")),
            })),
        }));
    assert.deepStrictEqual(maskSpans(dropStack(local.spans)), maskSpans(dropStack(http.spans)), "error span shape mismatch between transports");
});

// ---------------------------------------------------------------------------
// Metrics parity (instrument structure)
// ---------------------------------------------------------------------------

test("parity: metrics — identical instrument names, units, label keys", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            await client.echo(create(EchoRequestSchema, { message: "m" }));
        },
    });

    const httpShape = metricShape(http.metrics);
    const localShape = metricShape(local.metrics);
    assert.deepStrictEqual(localShape, httpShape, "metric instrument shape mismatch (names/units/labels) between transports");

    // The instruments the metrics guide lists for a client and a server, each recorded
    // by a unary call; the guide gives the duration histograms in seconds. Parity
    // alone would pass if both paths renamed an instrument or recorded none.
    const documentedNames = [
        "rpc.client.call.duration",
        "rpc.client.request.size",
        "rpc.client.response.size",
        "rpc.server.call.duration",
        "rpc.server.request.size",
        "rpc.server.response.size",
    ];
    for (const [label, shape] of [["http", httpShape], ["local", localShape]] as const) {
        assert.deepStrictEqual(
            shape.map((m) => m.name),
            documentedNames,
            `[${label}] recorded instruments`,
        );
        for (const metric of shape) {
            assert.strictEqual(Number(metric.type), DataPointType.HISTOGRAM, `[${label}] ${metric.name} is a histogram`);
        }
        for (const name of ["rpc.client.call.duration", "rpc.server.call.duration"]) {
            assert.strictEqual(shape.find((m) => m.name === name)?.unit, "s", `[${label}] ${name} is measured in seconds`);
        }
    }
});

// ---------------------------------------------------------------------------
// Context propagation (server span is child of client span)
// ---------------------------------------------------------------------------

test("parity: W3C trace-context — server span is child of client span on both transports", async () => {
    // This scenario depends on `trustRemote: true` (the suite default).
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors({ trustRemote: true }),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            // Start under an explicit root span so client gets a parent too.
            const tracer = trace.getTracer("parity-test");
            await tracer.startActiveSpan("root", async (root) => {
                try {
                    await context.with(trace.setSpan(context.active(), root), async () => {
                        await client.echo(create(EchoRequestSchema, { message: "p" }));
                    });
                } finally {
                    root.end();
                }
            });
        },
    });

    for (const [label, run] of [["http", http], ["local", local]] as const) {
        const root = run.spans.find((s) => s.name === "root");
        const clientSpan = run.spans.find((s) => s.kind === SpanKind.CLIENT);
        const serverSpan = run.spans.find((s) => s.kind === SpanKind.SERVER);
        assert.ok(root && clientSpan && serverSpan, `[${label}] missing one of root/client/server spans`);
        // All three must share the same traceId
        assert.strictEqual(clientSpan.traceId, root.traceId, `[${label}] client span must share trace with root`);
        assert.strictEqual(serverSpan.traceId, clientSpan.traceId, `[${label}] server span must share trace with client`);
        // Parent chain: server -> client -> root
        assert.strictEqual(clientSpan.parentSpanId, root.spanId, `[${label}] client must be child of root`);
        assert.strictEqual(serverSpan.parentSpanId, clientSpan.spanId, `[${label}] server must be child of client`);
    }

});

// ---------------------------------------------------------------------------
// Negative test: local instrument set is a subset of HTTP instrument set
// ---------------------------------------------------------------------------

test("parity: local-path instrument names are a subset of HTTP-path instruments", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            await client.echo(create(EchoRequestSchema, { message: "neg" }));
        },
    });

    const httpNames = new Set(http.metrics.map((m) => m.name));
    const localNames = new Set(local.metrics.map((m) => m.name));
    // The subset check below is vacuous for an empty set, so the local path must
    // be shown to record the documented instruments first.
    assert.ok(localNames.size > 0, "the local path records metrics");
    assert.ok(localNames.has("rpc.client.call.duration") && localNames.has("rpc.server.call.duration"), "the local path records both duration histograms");
    for (const name of localNames) {
        assert.ok(httpNames.has(name), `local-only instrument detected: ${name} (must be a subset of HTTP)`);
    }
});

// ---------------------------------------------------------------------------
// Bonus: smoke check that the `connectum.transport` attribute is present and
// distinguishes runs. This is the inverse of normalisation — proves the
// attribute is *actually* emitted (otherwise the parity tests above would be
// vacuously true).
// ---------------------------------------------------------------------------

test("parity: `connectum.transport` attribute differs between transports", async () => {
    // Fresh interceptor pair per run (see runBothTransports comment).
    const httpItcs = buildOtelInterceptors();
    const spansHttp = new InMemorySpanCollector();
    const spansLocal = new InMemorySpanCollector();

    const httpServer = createServer({ services: [echoRoutes()], interceptors: [httpItcs.server], port: 0, allowHTTP1: false });
    await httpServer.start();
    const httpPort = httpServer.address?.port;
    if (!httpPort) {
        await httpServer.stop();
        throw new Error("port not bound");
    }
    try {
        await shutdownProvider();
        trace.disable();
        trace.setGlobalTracerProvider(spansHttp.provider);
        const transport = createGrpcTransport({ baseUrl: `http://localhost:${httpPort}`, interceptors: [httpItcs.client] });
        await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "h" }));
    } finally {
        await httpServer.stop();
    }

    const localItcs = buildOtelInterceptors();
    const localServer = createServer({ services: [echoRoutes()], interceptors: [localItcs.server] });
    await shutdownProvider();
    trace.disable();
    trace.setGlobalTracerProvider(spansLocal.provider);
    await createClient(EchoService, createLocalTransport(localServer, { interceptors: [localItcs.client] })).echo(create(EchoRequestSchema, { message: "l" }));

    // Raw exporter access — bypass the normalising `flush()` so we can
    // observe the `connectum.transport` attribute that is normally stripped.
    const httpRaw = spansHttp.exporter.getFinishedSpans();
    const localRaw = spansLocal.exporter.getFinishedSpans();
    assert.ok(httpRaw.length > 0 && localRaw.length > 0, "no spans captured");
    for (const s of httpRaw) {
        assert.strictEqual(s.attributes[ATTR_CONNECTUM_TRANSPORT], "http", `HTTP span missing connectum.transport=http (name=${s.name}, kind=${s.kind})`);
    }
    for (const s of localRaw) {
        assert.strictEqual(s.attributes[ATTR_CONNECTUM_TRANSPORT], "in-process", `local span missing connectum.transport=in-process (name=${s.name}, kind=${s.kind})`);
    }

    // Symbol kept referenced so the import is not flagged unused.
    void ATTR_CONNECTUM_TRANSPORT_METRIC;

    await spansHttp.dispose();
    await spansLocal.dispose();
});

// ---------------------------------------------------------------------------
// Spans started inside streaming handlers hang off the server span
// ---------------------------------------------------------------------------

test("parity: spans started in streaming handlers are children of the server span on both transports", async () => {
    const handlerSpan = (phase: string) => {
        trace.getTracer("handler").startActiveSpan(`handler.${phase}`, (span) => {
            span.end();
        });
    };
    const services = [
        defineService(StreamingService, {
            echo: (req) => create(ItemSchema, { value: req.value }),
            async client(requests) {
                handlerSpan("client-start");
                let total = 0;
                for await (const _ of requests) total++;
                return { total };
            },
            async *server(req) {
                handlerSpan("server-start");
                await new Promise((resolve) => setImmediate(resolve));
                handlerSpan("server-after-await");
                yield create(ItemSchema, { value: req.value });
                handlerSpan("server-after-yield");
            },
            async *bidi(requests) {
                handlerSpan("bidi-start");
                for await (const item of requests) {
                    await new Promise((resolve) => setImmediate(resolve));
                    handlerSpan("bidi-after-await");
                    yield item;
                    handlerSpan("bidi-after-yield");
                }
            },
        }),
    ];
    const { http, local } = await runBothTransports({
        services,
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(StreamingService, fn);
            const one = async function* () {
                yield create(ItemSchema, { value: "m" });
            };
            await client.client(one());
            for await (const _ of client.server(create(ItemSchema, { value: "s" }))) {
                /* drain */
            }
            for await (const _ of client.bidi(one())) {
                /* drain */
            }
        },
    });

    for (const [label, run] of [
        ["http", http],
        ["local", local],
    ] as const) {
        const serverSpans = new Map(run.spans.filter((s) => s.kind === SpanKind.SERVER).map((s) => [s.name.split("/")[1], s.spanId]));
        const expectedParent: Record<string, string | undefined> = {
            "handler.client-start": serverSpans.get("Client"),
            "handler.server-start": serverSpans.get("Server"),
            "handler.server-after-await": serverSpans.get("Server"),
            "handler.server-after-yield": serverSpans.get("Server"),
            "handler.bidi-start": serverSpans.get("Bidi"),
            "handler.bidi-after-await": serverSpans.get("Bidi"),
            "handler.bidi-after-yield": serverSpans.get("Bidi"),
        };
        const handlerSpans = run.spans.filter((s) => s.name.startsWith("handler."));
        assert.strictEqual(handlerSpans.length, Object.keys(expectedParent).length, `${label}: every handler span was exported`);
        for (const s of handlerSpans) {
            assert.ok(expectedParent[s.name], `${label}: ${s.name} has a server span to hang off`);
            assert.strictEqual(s.parentSpanId, expectedParent[s.name], `${label}: ${s.name} is a child of its call's server span`);
        }
    }
    assert.deepStrictEqual(maskSpans(local.spans), maskSpans(http.spans), "span shape mismatch between transports");
});

// ---------------------------------------------------------------------------
// Attribute contract (names and value forms from the OpenTelemetry RPC
// conventions for Connect: rpc.system.name, fully qualified rpc.method,
// rpc.response.status_code). Key spellings are literals on purpose.
// ---------------------------------------------------------------------------

function durationPoints(metrics: NormalizedMetric[], name: string): Array<Record<string, unknown>> {
    return metrics.filter((m) => m.name === name).flatMap((m) => m.points.map((p) => p.attributes));
}

test("contract: a successful unary call reports rpc.system.name, qualified rpc.method and rpc.response.status_code=OK on spans and duration metrics", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            await createClient(EchoService, fn).echo(create(EchoRequestSchema, { message: "x" }));
        },
    });

    for (const run of [http, local]) {
        for (const kind of [SpanKind.SERVER, SpanKind.CLIENT]) {
            const span = run.spans.find((s) => s.kind === kind);
            assert.ok(span, `span of kind ${kind} missing`);
            assert.strictEqual(span.attributes["rpc.system.name"], "connectrpc");
            assert.strictEqual(span.attributes["rpc.method"], `${EchoService.typeName}/Echo`);
            assert.strictEqual(span.name, `${EchoService.typeName}/Echo`, "span name equals rpc.method");
            assert.strictEqual(span.attributes["rpc.response.status_code"], "OK");
            assert.ok(!("error.type" in span.attributes), "error.type must not be set on success");
            for (const removed of ["rpc.system", "rpc.service", "rpc.connect_rpc.status_code"]) {
                assert.ok(!(removed in span.attributes), `${removed} must not be emitted`);
            }
        }
        for (const name of ["rpc.server.call.duration", "rpc.client.call.duration"]) {
            const points = durationPoints(run.metrics, name);
            assert.strictEqual(points.length, 1, `${name} should have exactly one series`);
            const attrs = points[0] as Record<string, unknown>;
            assert.strictEqual(attrs["rpc.system.name"], "connectrpc");
            assert.strictEqual(attrs["rpc.method"], `${EchoService.typeName}/Echo`);
            assert.strictEqual(attrs["rpc.response.status_code"], "OK");
            assert.ok(!("error.type" in attrs));
        }
    }
});

test("contract: a failed unary call reports the same status string as rpc.response.status_code and error.type on duration metrics", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes({ throwError: true })],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            await assert.rejects(() => createClient(EchoService, fn).echo(create(EchoRequestSchema, { message: "x" })));
        },
    });

    for (const run of [http, local]) {
        for (const name of ["rpc.server.call.duration", "rpc.client.call.duration"]) {
            const points = durationPoints(run.metrics, name);
            assert.strictEqual(points.length, 1, `${name} should have exactly one series`);
            const attrs = points[0] as Record<string, unknown>;
            assert.strictEqual(attrs["rpc.response.status_code"], "FAILED_PRECONDITION");
            assert.strictEqual(attrs["error.type"], "FAILED_PRECONDITION");
            assert.ok(!("rpc.connect_rpc.status_code" in attrs));
        }
    }
});

test("contract: rpc.message events are not recorded unless recordMessages is set to true", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => ({
            server: createOtelInterceptor({ serverAddress: "test-server" }),
            client: createOtelClientInterceptor({ serverAddress: "test-server" }),
        }),
        scenario: async ({ fn }) => {
            await createClient(EchoService, fn).echo(create(EchoRequestSchema, { message: "x" }));
        },
    });

    for (const run of [http, local]) {
        assert.ok(run.spans.length >= 2, "server and client spans expected");
        for (const span of run.spans) {
            assert.deepStrictEqual(
                span.events.filter((e) => e.name === "rpc.message"),
                [],
                "default configuration must not record rpc.message events",
            );
        }
    }

    const enabled = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            await createClient(EchoService, fn).echo(create(EchoRequestSchema, { message: "x" }));
        },
    });
    const serverSpan = enabled.local.spans.find((s) => s.kind === SpanKind.SERVER);
    assert.deepStrictEqual(
        serverSpan?.events.map((e) => e.attributes["rpc.message.type"]),
        ["RECEIVED", "SENT"],
        "explicit recordMessages: true records one RECEIVED and one SENT event",
    );
});

// ---------------------------------------------------------------------------
// Message sizes with real protobuf-es v2 messages
// ---------------------------------------------------------------------------

/** Sum and count of every point of one histogram, across attribute sets. */
function histogramOf(metrics: NormalizedMetric[], name: string): { sum: number; count: number } {
    let sum = 0;
    let count = 0;
    for (const point of metrics.find((m) => m.name === name)?.points ?? []) {
        const value = point.value as { sum: number; count: number };
        sum += value.sum;
        count += value.count;
    }
    return { sum, count };
}

/** The `rpc.message` events of the span of one kind, as [type, id, size]. */
function messageEvents(spans: NormalizedSpan[], kind: SpanKind): Array<[unknown, unknown, unknown]> {
    const span = spans.find((s) => s.kind === kind);
    assert.ok(span, `span of kind ${kind} missing`);
    return span.events
        .filter((e) => e.name === "rpc.message")
        .map((e): [unknown, unknown, unknown] => [e.attributes["rpc.message.type"], e.attributes["rpc.message.id"], e.attributes["rpc.message.uncompressed_size"]])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
}

test("parity: size histograms and rpc.message sizes of a unary call are the serialized byte length on both transports", async () => {
    // Oracle: the protobuf wire encoding computed by the library itself from the schema
    // (toBinary), not by the package under test. protobuf-es v2 messages have no
    // toBinary() method, so a size read from the message object is always 0.
    const request = create(EchoRequestSchema, { message: "x".repeat(5000) });
    const expectedRequestSize = toBinary(EchoRequestSchema, request).byteLength;
    const expectedResponseSize = toBinary(EchoResponseSchema, create(EchoResponseSchema, { message: `echo:${request.message}`, timestamp: 0n })).byteLength;
    assert.ok(expectedRequestSize > 5000 && expectedResponseSize > 5000, "the fixture messages are large");

    const { http, local } = await runBothTransports({
        services: [echoRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            await createClient(EchoService, fn).echo(request);
        },
    });

    for (const [label, run] of [["http", http], ["local", local]] as const) {
        assert.deepStrictEqual(histogramOf(run.metrics, "rpc.server.request.size"), { sum: expectedRequestSize, count: 1 }, `[${label}] rpc.server.request.size`);
        assert.deepStrictEqual(histogramOf(run.metrics, "rpc.server.response.size"), { sum: expectedResponseSize, count: 1 }, `[${label}] rpc.server.response.size`);
        assert.deepStrictEqual(histogramOf(run.metrics, "rpc.client.request.size"), { sum: expectedRequestSize, count: 1 }, `[${label}] rpc.client.request.size`);
        assert.deepStrictEqual(histogramOf(run.metrics, "rpc.client.response.size"), { sum: expectedResponseSize, count: 1 }, `[${label}] rpc.client.response.size`);
        assert.deepStrictEqual(messageEvents(run.spans, SpanKind.SERVER), [["RECEIVED", 1, expectedRequestSize], ["SENT", 1, expectedResponseSize]], `[${label}] server rpc.message events`);
        assert.deepStrictEqual(messageEvents(run.spans, SpanKind.CLIENT), [["RECEIVED", 1, expectedResponseSize], ["SENT", 1, expectedRequestSize]], `[${label}] client rpc.message events`);
    }
});

test("parity: rpc.message events of a server-streaming call carry the serialized size of every message, the aggregate size histograms stay zero", async () => {
    const request = create(ItemSchema, { value: "s", sequence: 3 });
    const sizeOf = (i: number) => toBinary(ItemSchema, create(ItemSchema, { value: `s:${i}`, sequence: i })).byteLength;
    const requestSize = toBinary(ItemSchema, request).byteLength;

    const { http, local } = await runBothTransports({
        services: [streamingRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            for await (const _ of createClient(StreamingService, fn).server(request)) {
                // Drain the stream: the spans end with it.
            }
        },
    });

    for (const [label, run] of [["http", http], ["local", local]] as const) {
        assert.deepStrictEqual(
            messageEvents(run.spans, SpanKind.SERVER),
            [["RECEIVED", 1, requestSize], ["SENT", 1, sizeOf(0)], ["SENT", 2, sizeOf(1)], ["SENT", 3, sizeOf(2)]],
            `[${label}] server rpc.message events`,
        );
        assert.deepStrictEqual(
            messageEvents(run.spans, SpanKind.CLIENT),
            [["RECEIVED", 1, sizeOf(0)], ["RECEIVED", 2, sizeOf(1)], ["RECEIVED", 3, sizeOf(2)], ["SENT", 1, requestSize]],
            `[${label}] client rpc.message events`,
        );
        // The metrics guide: for streaming RPCs the aggregate size measurements are recorded as zero.
        for (const name of ["rpc.server.request.size", "rpc.server.response.size", "rpc.client.request.size", "rpc.client.response.size"]) {
            assert.strictEqual(histogramOf(run.metrics, name).sum, 0, `[${label}] ${name} is zero for a streaming call`);
        }
    }
});

// ---------------------------------------------------------------------------
// Streaming calls last until the stream ends
// ---------------------------------------------------------------------------

const STEP_MS = 100;

/** A server-streaming service whose messages are STEP_MS apart; with `failAt`, it fails with UNAVAILABLE before that message. */
function slowStreamingRoutes(failAt?: number) {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server(req) {
            for (let i = 0; i < 4; i++) {
                await delay(STEP_MS);
                if (i === failAt) throw new ConnectError("backend gone", Code.Unavailable);
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
            }
        },
        async client(requests) {
            let total = 0;
            for await (const _ of requests) total++;
            return { total };
        },
        async *bidi(requests) {
            for await (const item of requests) yield create(ItemSchema, { value: item.value, sequence: item.sequence });
        },
    });
}

test("parity: the duration histograms of a streaming call cover the whole stream on both transports", async () => {
    // Oracle: the OpenTelemetry RPC metrics conventions: reported alongside an RPC span,
    // the duration metric SHOULD be the span duration; the span of a stream lasts until the
    // stream ends. The stream takes 4 x 100 ms; the bound 0.3 s tells that from the time to
    // the response head (a few ms) and survives a loaded machine.
    const { http, local } = await runBothTransports({
        services: [slowStreamingRoutes()],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            for await (const _ of createClient(StreamingService, fn).server(create(ItemSchema, { value: "s" }))) {
                // Drain the stream: the calls end with it.
            }
        },
    });

    for (const [label, run] of [["http", http], ["local", local]] as const) {
        for (const name of ["rpc.server.call.duration", "rpc.client.call.duration"]) {
            const duration = histogramOf(run.metrics, name);
            assert.strictEqual(duration.count, 1, `[${label}] ${name}: one point per call`);
            assert.ok(duration.sum >= 0.3, `[${label}] ${name} covers the stream, got ${duration.sum} s`);
            const point = run.metrics.find((m) => m.name === name)?.points[0];
            assert.ok(point && !("error.type" in point.attributes), `[${label}] ${name}: a stream that ended normally carries no error.type`);
        }
    }
});

test("parity: a stream that fails after it started carries error.type and rpc.response.status_code on spans and duration metrics on both transports", async () => {
    // Oracle: the Connect RPC conventions: error.type is the status code of a failed call
    // (UNAVAILABLE is one of the codes that are errors for a server and a client), and
    // rpc.response.status_code is the Connect code name.
    const { http, local } = await runBothTransports({
        services: [slowStreamingRoutes(2)],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            await assert.rejects(
                async () => {
                    for await (const _ of createClient(StreamingService, fn).server(create(ItemSchema, { value: "s" }))) {
                        // Drain until the stream fails.
                    }
                },
                (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable,
            );
        },
    });

    for (const [label, run] of [["http", http], ["local", local]] as const) {
        for (const [kind, name] of [[SpanKind.SERVER, "rpc.server.call.duration"], [SpanKind.CLIENT, "rpc.client.call.duration"]] as const) {
            const span = run.spans.find((s) => s.kind === kind);
            assert.ok(span, `[${label}] span of kind ${kind} missing`);
            assert.strictEqual(span.attributes["error.type"], "UNAVAILABLE", `[${label}] span ${kind} error.type`);
            assert.strictEqual(span.attributes["rpc.response.status_code"], "UNAVAILABLE", `[${label}] span ${kind} rpc.response.status_code`);
            assert.strictEqual(span.status.code, 2 /* SpanStatusCode.ERROR */, `[${label}] span ${kind} status`);
            const duration = histogramOf(run.metrics, name);
            assert.strictEqual(duration.count, 1, `[${label}] ${name}: one point per call`);
            assert.ok(duration.sum >= 0.2, `[${label}] ${name} covers the stream up to the failure, got ${duration.sum} s`);
            const point = run.metrics.find((m) => m.name === name)?.points[0];
            assert.strictEqual(point?.attributes["error.type"], "UNAVAILABLE", `[${label}] ${name} error.type`);
            assert.strictEqual(point?.attributes["rpc.response.status_code"], "UNAVAILABLE", `[${label}] ${name} rpc.response.status_code`);
        }
    }
});
