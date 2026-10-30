/**
 * `transportParityTest` with `@connectum/otel`: the driver's per-run collectors
 * (`ctx.spans`, `ctx.metrics`) fed by the real interceptors, compared with the
 * default comparison.
 *
 * Duration histograms hold the measured time, which differs between the HTTP/2
 * and the in-process leg; the default comparison must still pass for identical
 * behaviour and compare how many calls were recorded under which attributes.
 * Several scenarios follow one another in this file on purpose: each one must
 * record its own telemetry, not the first scenario's.
 */

// No exporter: the in-memory collectors are the only recipients of the telemetry.
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { InMemorySpanCollector } from "@connectum/testing";
import { defaultCompare, type ParityScenarioContext, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { context, metrics as metricsApi, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// A context manager and a propagator are not installed by the in-memory
// collectors; without them the server span would not see the client span.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const services = [
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    }),
];

/**
 * One echo call with the run's collectors installed as the OpenTelemetry
 * globals, and the telemetry it recorded. `shutdownProvider()` first, because
 * `@connectum/otel` keeps the tracer and meter it created for the previously
 * registered providers until its own provider is shut down.
 */
async function echoWithTelemetry(ctx: ParityScenarioContext): Promise<ParityScenarioResult> {
    await shutdownProvider();
    trace.disable();
    metricsApi.disable();
    trace.setGlobalTracerProvider(ctx.spans.provider);
    metricsApi.setGlobalMeterProvider(ctx.metrics.provider);
    try {
        const response = await createClient(EchoService, ctx.transport).echo(create(EchoRequestSchema, { message: "x" }));
        return { response: { message: response.message }, spans: ctx.spans.flush(), metrics: await ctx.metrics.flush() };
    } finally {
        await shutdownProvider();
        trace.disable();
        metricsApi.disable();
    }
}

/** The observations a histogram recorded, by attributes. */
function observationCounts(result: ParityScenarioResult, name: string): number[] {
    return (result.metrics ?? [])
        .filter((m) => m.name === name)
        .flatMap((m) => m.points.map((p) => (p.value as { count: number }).count));
}

for (const label of ["first", "second", "third"]) {
    transportParityTest(`otel parity driver: the ${label} scenario records its own spans and metrics and passes the default comparison`, {
        services,
        // `trustRemote` makes the server span a child of the propagated client span on both
        // legs; without it the in-process leg would still nest the spans while HTTP only links them.
        interceptors: [createOtelInterceptor({ trustRemote: true })],
        clientInterceptors: [createOtelClientInterceptor({ serverAddress: "test-server" })],
        scenario: echoWithTelemetry,
        compare: (http, local) => {
            // A comparison of two empty results passes on its own: pin that each leg
            // recorded a client and a server span and one call per duration histogram.
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                assert.strictEqual(result.spans?.length, 2, `${name} leg must record the client and the server span`);
                assert.deepStrictEqual(observationCounts(result, "rpc.server.call.duration"), [1], `${name} leg must record one server call duration`);
                assert.deepStrictEqual(observationCounts(result, "rpc.client.call.duration"), [1], `${name} leg must record one client call duration`);
            }
            defaultCompare(http, local);
        },
    });
}

// The reason every scenario above starts with `shutdownProvider()`: `@connectum/otel`
// keeps the tracer it created for the provider that was registered when it first
// recorded something. A later scenario that registers its own collector without
// shutting the provider down records nothing, and a parity comparison of two empty
// results passes. This pins the behaviour the testing guide and the collector
// documentation describe; if it stops being true they must change with it.
test("otel parity driver: a scenario that does not call shutdownProvider() first records nothing after an earlier one", async () => {
    const recordOnce = async (shutdownFirst: boolean): Promise<number> => {
        const collector = new InMemorySpanCollector();
        try {
            if (shutdownFirst) await shutdownProvider();
            trace.disable();
            trace.setGlobalTracerProvider(collector.provider);
            const server = createServer({ services, interceptors: [createOtelInterceptor()], port: 0 });
            await createClient(EchoService, createLocalTransport(server)).echo(create(EchoRequestSchema, { message: "x" }));
            return collector.flush().length;
        } finally {
            trace.disable();
            await collector.dispose();
        }
    };

    await shutdownProvider();
    assert.strictEqual(await recordOnce(false), 1, "the first scenario records its server span");
    assert.strictEqual(await recordOnce(false), 0, "the next scenario records nothing: the provider still holds the tracer of the first");
    assert.strictEqual(await recordOnce(true), 1, "shutdownProvider() first makes the scenario record again");
    await shutdownProvider();
});
