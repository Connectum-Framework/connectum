/**
 * Cross-transport parity test driver.
 *
 * Registers a `node:test` test that runs the given scenario *twice* — once
 * against an HTTP/2 server (via `createGrpcTransport`) and once against the
 * in-process router transport (`createLocalTransport`). Both servers are
 * created with identical configuration: same services, same server-side
 * interceptors, same protocols.
 *
 * After both runs complete, the driver performs a structural diff over the
 * scenario's reported `ParityScenarioResult` and fails the test if any
 * non-transport-specific field differs.
 *
 * @module transportParityTest
 */

import assert from "node:assert";
import { test } from "node:test";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createLocalTransport, createServer, type ProtocolRegistration, type Server, type ServiceRoute } from "@connectum/core";
import { InMemoryMetricCollector, InMemorySpanCollector, type NormalizedMetric, type NormalizedSpan } from "./otel-collectors.ts";

/**
 * Identifies which transport a scenario invocation is running against.
 */
export type TransportKind = "http" | "local";

/**
 * Per-invocation context passed to the scenario function.
 */
export interface ParityScenarioContext {
    /** Active client transport for this run. */
    transport: Transport;
    /** Which transport this run uses. */
    transportKind: TransportKind;
    /** The server instance — useful for inspection (e.g. `server.address`). */
    server: Server;
    /** Base URL for the HTTP server, only defined when `transportKind === "http"`. */
    baseUrl: string | undefined;
    /** Fresh span collector for this run (no cross-contamination between runs). */
    spans: InMemorySpanCollector;
    /** Fresh metric collector for this run. */
    metrics: InMemoryMetricCollector;
}

/**
 * Result reported by a scenario for a single transport.
 *
 * Every field is optional; the parity driver compares only fields that are
 * present in *both* runs (asymmetric presence is a parity failure).
 */
export interface ParityScenarioResult {
    /** Successful response payload (must be JSON-serializable for diff). */
    response?: unknown;
    /** Response headers reported by the client. */
    responseHeaders?: Record<string, string>;
    /** Response trailers reported by the client. */
    trailers?: Record<string, string>;
    /** Error captured during the scenario. */
    error?: {
        code: number | string;
        message: string;
        details?: unknown;
        metadata?: Record<string, string>;
    };
    /** Spans observed during the scenario (already normalized — pass `await ctx.spans.flush()`). */
    spans?: NormalizedSpan[];
    /** Metrics observed during the scenario. */
    metrics?: NormalizedMetric[];
}

/**
 * Options for {@link transportParityTest}.
 */
export interface TransportParityTestOptions {
    /** Service route handlers registered on both servers. */
    services: ServiceRoute[];
    /** Server-side interceptors applied identically on both servers. */
    interceptors?: Interceptor[];
    /**
     * Client-side interceptors applied identically on both client transports
     * (e.g. an OTel client interceptor that must be the same instance for
     * both runs so they share a single `tracer` / `meter`). On HTTP they
     * are passed to `createGrpcTransport({ interceptors })`; on the local
     * path they are passed to `createLocalTransport(server, { interceptors })`.
     */
    clientInterceptors?: Interceptor[];
    /** Protocol extensions applied identically on both servers. */
    protocols?: ProtocolRegistration[];
    /**
     * The scenario under test. Invoked once per transport with a fresh
     * server, transport, and OTEL collector pair.
     */
    scenario: (ctx: ParityScenarioContext) => Promise<ParityScenarioResult>;
    /**
     * Optional custom comparison. Receives both results and should `throw`
     * (e.g. via `assert.deepStrictEqual`) when parity is violated.
     *
     * If omitted, {@link defaultCompare} is used, which performs structural
     * deep equality with normalization of trace/span identifiers.
     */
    compare?: (http: ParityScenarioResult, local: ParityScenarioResult) => void;
}

/**
 * Strip identifiers that are *expected* to differ between independent runs
 * (random trace IDs, random span IDs) so the structural diff focuses on
 * the behavioural shape.
 */
function maskSpanIds(spans: NormalizedSpan[] | undefined): unknown {
    if (!spans) {
        return undefined;
    }
    return spans.map((s) => ({
        name: s.name,
        kind: s.kind,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        // identifiers replaced with stable masks
        hasParent: s.parentSpanId !== undefined,
    }));
}

/**
 * Default structural diff for two scenario results.
 */
export function defaultCompare(http: ParityScenarioResult, local: ParityScenarioResult): void {
    assert.deepStrictEqual(local.response, http.response, "response payload mismatch between HTTP and local transports");
    if (http.error || local.error) {
        assert.deepStrictEqual(
            { code: local.error?.code, message: local.error?.message, details: local.error?.details, metadata: local.error?.metadata },
            { code: http.error?.code, message: http.error?.message, details: http.error?.details, metadata: http.error?.metadata },
            "error shape mismatch between HTTP and local transports",
        );
    }
    if (http.responseHeaders || local.responseHeaders) {
        assert.deepStrictEqual(local.responseHeaders ?? {}, http.responseHeaders ?? {}, "response headers mismatch");
    }
    if (http.trailers || local.trailers) {
        assert.deepStrictEqual(local.trailers ?? {}, http.trailers ?? {}, "trailers mismatch");
    }
    if (http.spans || local.spans) {
        assert.deepStrictEqual(maskSpanIds(local.spans), maskSpanIds(http.spans), "OTEL spans mismatch (after stripping connectum.transport)");
    }
    if (http.metrics || local.metrics) {
        assert.deepStrictEqual(local.metrics, http.metrics, "OTEL metrics mismatch (after stripping transport label)");
    }
}

interface RunHarness {
    server: Server;
    transport: Transport;
    baseUrl: string | undefined;
    spans: InMemorySpanCollector;
    metrics: InMemoryMetricCollector;
    cleanup: () => Promise<void>;
}

async function setupHttpHarness(opts: TransportParityTestOptions): Promise<RunHarness> {
    const server = createServer({
        services: opts.services,
        interceptors: opts.interceptors ?? [],
        protocols: opts.protocols ?? [],
        port: 0,
        allowHTTP1: false,
    });
    await server.start();
    const port = server.address?.port;
    if (!port) {
        await server.stop();
        throw new Error("HTTP server failed to bind a port");
    }
    const baseUrl = `http://localhost:${port}`;
    const transport = createGrpcTransport({ baseUrl, interceptors: opts.clientInterceptors ?? [] });
    const spans = new InMemorySpanCollector();
    const metrics = new InMemoryMetricCollector();
    return {
        server,
        transport,
        baseUrl,
        spans,
        metrics,
        cleanup: async () => {
            try {
                await server.stop();
            } finally {
                await spans.dispose();
                await metrics.dispose();
            }
        },
    };
}

function setupLocalHarness(opts: TransportParityTestOptions): RunHarness {
    const server = createServer({
        services: opts.services,
        interceptors: opts.interceptors ?? [],
        protocols: opts.protocols ?? [],
    });
    const transport = createLocalTransport(server, { interceptors: opts.clientInterceptors ?? [] });
    const spans = new InMemorySpanCollector();
    const metrics = new InMemoryMetricCollector();
    return {
        server,
        transport,
        baseUrl: undefined,
        spans,
        metrics,
        cleanup: async () => {
            // Local server was never started — no HTTP socket to close.
            // Calling `server.stop()` in the "created" state throws by design.
            await spans.dispose();
            await metrics.dispose();
        },
    };
}

/**
 * Register a `node:test` parity test that runs the same scenario over both
 * HTTP and in-process transports and asserts structural equivalence.
 *
 * @example
 * ```typescript
 * transportParityTest("Greeter.sayHello is identical across transports", {
 *   services: [greeterRoutes],
 *   scenario: async ({ transport }) => {
 *     const client = createClient(GreeterService, transport);
 *     const response = await client.sayHello({ name: "world" });
 *     return { response };
 *   },
 * });
 * ```
 */
export function transportParityTest(name: string, opts: TransportParityTestOptions): void {
    test(name, async () => {
        const compare = opts.compare ?? defaultCompare;

        const httpHarness = await setupHttpHarness(opts);
        let httpResult: ParityScenarioResult;
        try {
            httpResult = await opts.scenario({
                transport: httpHarness.transport,
                transportKind: "http",
                server: httpHarness.server,
                baseUrl: httpHarness.baseUrl,
                spans: httpHarness.spans,
                metrics: httpHarness.metrics,
            });
        } finally {
            await httpHarness.cleanup();
        }

        const localHarness = setupLocalHarness(opts);
        let localResult: ParityScenarioResult;
        try {
            localResult = await opts.scenario({
                transport: localHarness.transport,
                transportKind: "local",
                server: localHarness.server,
                baseUrl: undefined,
                spans: localHarness.spans,
                metrics: localHarness.metrics,
            });
        } finally {
            await localHarness.cleanup();
        }

        compare(httpResult, localResult);
    });
}
