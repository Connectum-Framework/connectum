/**
 * Tracing and the verified identity work together on streaming calls.
 *
 * A server interceptor chain that carries both an authentication interceptor
 * and the OpenTelemetry interceptor must give a generator handler the caller's
 * verified identity at every point of its life, whichever of the two is placed
 * first, and must not change what the telemetry records. The control run uses
 * the same handlers behind the OpenTelemetry interceptor alone; the runs with
 * authentication have to produce the same spans, events and statuses.
 * The spans come from a real tracer provider and an in-memory exporter.
 */

// MUST run before any @connectum/otel import resolves transitively.
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import { setImmediate as nextImmediate, setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createAuthInterceptor, getAuthContext } from "@connectum/auth";
import { createServer, defineService } from "@connectum/core";
import { InMemorySpanCollector } from "@connectum/testing";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

const PAIRS = Number(process.env.OTEL_AUTH_PAIRS ?? 100);
const LENGTH = 3;

type Order = "control" | "otel-then-auth" | "auth-then-otel";
type Method = "server" | "bidi";
type Transport = "local" | "http";

interface Phase {
    tag: string;
    phase: string;
    identity: string | undefined;
}

function routes(phases: Phase[]) {
    const note = (tag: string, phase: string) =>
        phases.push({ tag, phase, identity: getAuthContext()?.subject });
    const pause = async () => (Math.random() < 0.5 ? await nextImmediate() : await sleep(1));
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value }),
        client: async () => ({ total: 0 }),
        async *server(_req, ctx) {
            const tag = ctx.requestHeader.get("x-tag") ?? "none";
            note(tag, "start");
            try {
                for (let i = 0; i < LENGTH; i++) {
                    await pause();
                    note(tag, `before-yield-${i}`);
                    yield create(ItemSchema, { value: tag, sequence: i });
                    note(tag, `after-yield-${i}`);
                }
            } finally {
                note(tag, "finally");
            }
        },
        async *bidi(requests, ctx) {
            const tag = ctx.requestHeader.get("x-tag") ?? "none";
            note(tag, "start");
            try {
                let i = 0;
                for await (const _message of requests) {
                    await pause();
                    note(tag, `before-yield-${i}`);
                    yield create(ItemSchema, { value: tag, sequence: i });
                    note(tag, `after-yield-${i}`);
                    i++;
                }
            } finally {
                note(tag, "finally");
            }
        },
    });
}

async function* inputs(tag: string) {
    for (let i = 0; i < LENGTH; i++) {
        yield create(ItemSchema, { value: tag, sequence: i });
        await sleep(1);
    }
}

function interceptorsFor(order: Order): Interceptor[] {
    const otel = createOtelInterceptor({ recordMessages: true });
    const auth = createAuthInterceptor({ verifyCredentials: (token) => ({ subject: token, roles: [], scopes: [], claims: {}, type: "test" }) });
    switch (order) {
        case "control":
            return [otel];
        case "otel-then-auth":
            return [otel, auth];
        case "auth-then-otel":
            return [auth, otel];
    }
}

async function execute(order: Order, transport: Transport, method: Method) {
    const collector = new InMemorySpanCollector();
    await shutdownProvider();
    trace.disable();
    trace.setGlobalTracerProvider(collector.provider);
    const phases: Phase[] = [];
    const server = createServer({ services: [routes(phases)], interceptors: interceptorsFor(order), port: 0, allowHTTP1: false, shutdown: { timeout: 1_000 } });
    await server.start();
    try {
        const client = transport === "local" ? server.localClient(StreamingService) : createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
        const call = async (identity: string) => {
            const headers = { authorization: `Bearer ${identity}`, "x-tag": identity };
            const stream = method === "server" ? client.server(create(ItemSchema, { value: identity }), { headers }) : client.bidi(inputs(identity), { headers });
            for await (const _message of stream) {
                await nextImmediate();
            }
        };
        for (let i = 0; i < PAIRS; i++) {
            await Promise.all([call(`${order}-${transport}-${method}-${i}-A`), call(`${order}-${transport}-${method}-${i}-B`)]);
        }
        await sleep(50);
        const spans = collector.exporter.getFinishedSpans();
        return { phases, spans };
    } finally {
        await server.stop();
        await shutdownProvider();
        trace.disable();
        await collector.dispose();
    }
}

/** The shape of the telemetry a run produced, independent of ids and timing. */
function telemetryShape(result: Awaited<ReturnType<typeof execute>>) {
    const serverSpans = result.spans.filter((span) => span.kind === SpanKind.SERVER);
    const events = new Map<number, number>();
    for (const span of serverSpans) {
        events.set(span.events.length, (events.get(span.events.length) ?? 0) + 1);
    }
    return {
        serverSpans: serverSpans.length,
        eventCountsPerSpan: [...events.entries()].sort(([a], [b]) => a - b),
        statusCodes: [...new Set(serverSpans.map((span) => span.status.code))],
        distinctSpanIds: new Set(serverSpans.map((span) => span.spanContext().spanId)).size,
    };
}


for (const transport of ["local", "http"] as const) {
    for (const method of ["server", "bidi"] as const) {
        describe(`OpenTelemetry with authentication, ${transport} ${method}`, () => {
            it(`keeps the identity at every phase and the telemetry identical to the run without authentication (${PAIRS} pairs)`, async () => {
                const control = await execute("control", transport, method);
                const expectedShape = telemetryShape(control);
                assert.strictEqual(expectedShape.serverSpans, PAIRS * 2, "the control run traced every call");
                assert.ok(expectedShape.statusCodes.length > 0);

                for (const order of ["otel-then-auth", "auth-then-otel"] as const) {
                    const result = await execute(order, transport, method);
                    const wrong = result.phases.filter((phase) => phase.identity !== phase.tag);
                    assert.deepStrictEqual(wrong.slice(0, 3), [], `${order}: ${wrong.length} of ${result.phases.length} phases saw the wrong identity`);
                    assert.ok(result.phases.length >= PAIRS * 2 * (LENGTH * 2 + 2));
                    assert.deepStrictEqual(telemetryShape(result), expectedShape, `${order}: spans and events differ from the control run`);
                }
            });
        });
    }
}
