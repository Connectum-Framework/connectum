/**
 * Group 7a — OpenTelemetry tracing & metrics parity for in-process transport.
 *
 * Asserts that `@connectum/otel` produces structurally identical OTel spans
 * and metric instruments across HTTP and in-process transports. The only
 * permitted differences are the `connectum.transport` span attribute and
 * the `transport` metric label (both stripped by the parity collectors
 * before structural diff).
 *
 *   7a.5  unary → CLIENT + SERVER spans, parent-child, identical attrs
 *   7a.6  streaming → N `rpc.message` SENT / N RECEIVED events
 *   7a.7  error case → span status=ERROR, rpc.connect_rpc.status_code matches
 *   7a.8  metrics — identical instrument names, label keys, observable shape
 *   7a.9  context propagation — server span is child of client span
 *   7a.10 instrument-name subset (no transport-specific metrics)
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

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer } from "@connectum/core";
import { context, metrics as metricsApi, propagation, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

import { ATTR_CONNECTUM_TRANSPORT, ATTR_CONNECTUM_TRANSPORT_METRIC } from "../../src/attributes.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// Register an AsyncLocalStorage-backed context manager once at module load.
// `BasicTracerProvider` (used by our in-memory collectors) does not register
// one, so without this `context.with()` and `context.active()` are no-ops —
// which breaks W3C trace-context propagation (7a.9).
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
    return (router: ConnectRouter) => {
        router.service(EchoService, {
            echo: (req) => {
                if (opts?.throwError) {
                    throw new ConnectError("forced failure", Code.FailedPrecondition);
                }
                return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    };
}

function streamingRoutes() {
    return (router: ConnectRouter) => {
        router.service(StreamingService, {
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
    };
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
 * is what 7a.8/7a.10 need: values from histogram timings differ run-to-run
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
// 7a.5 — Unary span parity
// ---------------------------------------------------------------------------

test("parity 7a.5: unary RPC produces identical CLIENT+SERVER spans", async () => {
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

    // After stripping `connectum.transport` (done in normalizeSpan), the
    // structural shape must be identical.
    assert.deepStrictEqual(maskSpans(local.spans), maskSpans(http.spans), "span shape mismatch between transports (after stripping connectum.transport)");
});

// ---------------------------------------------------------------------------
// 7a.6 — Streaming span events parity
// ---------------------------------------------------------------------------

test("parity 7a.6: server-streaming emits identical rpc.message events", async () => {
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

    // Both runs: count of SENT and RECEIVED rpc.message events must match
    // and event sequencing must be identical.
    const httpEvents = http.spans.flatMap((s) => s.events.map((e) => ({ name: e.name, type: e.attributes["rpc.message.type"], id: e.attributes["rpc.message.id"] })));
    const localEvents = local.spans.flatMap((s) => s.events.map((e) => ({ name: e.name, type: e.attributes["rpc.message.type"], id: e.attributes["rpc.message.id"] })));
    assert.deepStrictEqual(localEvents, httpEvents, "rpc.message event shape mismatch between transports");

    // Structural shape parity (attributes minus transport)
    assert.deepStrictEqual(maskSpans(local.spans), maskSpans(http.spans), "streaming span shape mismatch");
});

// ---------------------------------------------------------------------------
// 7a.7 — Error span parity
// ---------------------------------------------------------------------------

test("parity 7a.7: error case → span status=ERROR identical on both transports", async () => {
    const { http, local } = await runBothTransports({
        services: [echoRoutes({ throwError: true })],
        buildInterceptors: () => buildOtelInterceptors(),
        scenario: async ({ fn }) => {
            const client = createClient(EchoService, fn);
            await assert.rejects(() => client.echo(create(EchoRequestSchema, { message: "x" })), (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition);
        },
    });

    // Both runs must record ERROR status with matching connect_rpc status code.
    for (const run of [http, local]) {
        const serverSpan = run.spans.find((s) => s.kind === SpanKind.SERVER);
        assert.ok(serverSpan, "server span missing");
        assert.strictEqual(serverSpan.status.code, 2 /* SpanStatusCode.ERROR */, "server span must be ERROR");
        assert.strictEqual(serverSpan.attributes["rpc.connect_rpc.status_code"], Code.FailedPrecondition, "connect_rpc.status_code mismatch");
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
// 7a.8 — Metrics parity (instrument structure)
// ---------------------------------------------------------------------------

test("parity 7a.8: metrics — identical instrument names, units, label keys", async () => {
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

    // Sanity: each transport must emit at least the standard RPC histograms.
    const httpNames = new Set(httpShape.map((m) => m.name));
    for (const expected of [
        "rpc.client.call.duration",
        "rpc.client.request.size",
        "rpc.client.response.size",
        "rpc.server.call.duration",
        "rpc.server.request.size",
        "rpc.server.response.size",
    ]) {
        assert.ok(httpNames.has(expected), `expected instrument ${expected} missing from HTTP run`);
    }
});

// ---------------------------------------------------------------------------
// 7a.9 — Context propagation (server span is child of client span)
// ---------------------------------------------------------------------------

test("parity 7a.9: W3C trace-context — server span is child of client span on both transports", async () => {
    // 7a.9 specifically depends on `trustRemote: true` (the suite default).
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
// 7a.10 — Negative test: local instrument set is a subset of HTTP instrument set
// ---------------------------------------------------------------------------

test("parity 7a.10: local-path instrument names are a subset of HTTP-path instruments", async () => {
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

test("parity 7a.bonus: `connectum.transport` attribute differs between transports", async () => {
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
