/**
 * The OTel client interceptor mounted in `outgoingInterceptors` produces one
 * finished CLIENT span per catalog call on a resolver route, the same as on
 * the in-process route: a `ctx.call` that leaves the process over gRPC and a
 * standalone catalog client with its own explicit chain both start, end and
 * export exactly one span, and the receiver sees the injected `traceparent`.
 */
// MUST run before any @connectum/otel import resolves transitively.
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createCatalogClient, createServer, defineCatalog, defineService, type Server, singleTransportResolver } from "@connectum/core";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, NodeTracerProvider, type ReadableSpan, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { type Item, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
    }
}

class CountingProcessor implements SpanProcessor {
    started = 0;
    ended = 0;
    onStart(): void {
        this.started++;
    }
    onEnd(): void {
        this.ended++;
    }
    async forceFlush(): Promise<void> {}
    async shutdown(): Promise<void> {}
}

let counter: CountingProcessor;
let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;
let receiver: Server;
let baseUrl: string;
let lastTraceparent: string | null;

before(async () => {
    receiver = createServer({
        services: [
            defineService(StreamingService, {
                echo: (req, ctx) => {
                    lastTraceparent = ctx.requestHeader.get("traceparent");
                    return create(ItemSchema, { value: req.value, sequence: req.sequence });
                },
                async *server() {},
                client: async () => {
                    throw new Error("unused");
                },
                async *bidi() {},
            }),
        ],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        shutdown: { timeout: 200 },
    });
    await receiver.start();
    baseUrl = `http://127.0.0.1:${receiver.address?.port}`;
});
after(async () => {
    await receiver.stop();
});

beforeEach(async () => {
    counter = new CountingProcessor();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [counter, new SimpleSpanProcessor(exporter)] });
    lastTraceparent = null;
    await shutdownProvider();
    trace.disable();
    context.disable();
    propagation.disable();
    // Like the production provider: an async context manager (so the active
    // span is visible when the interceptor injects) and the W3C propagator
    // (without one `propagation.inject` is a no-op).
    provider.register({ propagator: new W3CTraceContextPropagator() });
});
afterEach(async () => {
    await shutdownProvider();
    trace.disable();
    context.disable();
    propagation.disable();
    await provider.shutdown();
});

function assertOneClientSpan(): ReadableSpan {
    assert.strictEqual(counter.started, 1, "onStart count");
    assert.strictEqual(counter.ended, 1, "onEnd count");
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1, "exported span count");
    const span = spans[0] as ReadableSpan;
    assert.strictEqual(span.kind, SpanKind.CLIENT);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.strictEqual(span.attributes["connectum.transport"], "http");
    assert.ok(lastTraceparent?.includes(span.spanContext().traceId), "the receiver must see the traceparent of the client span");
    return span;
}

const catalog = defineCatalog({ [StreamingService.typeName]: StreamingService, [EchoService.typeName]: EchoService });

describe("outgoingInterceptors — OTel client span on a resolver route", () => {
    it("ctx.call leaving the process over gRPC: exactly one finished CLIENT span", async () => {
        const server = createServer({
            services: [
                defineService(EchoService, {
                    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    async secureEcho(_req, ctx) {
                        const item = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "remote", sequence: 1 }));
                        return create(EchoResponseSchema, { message: item.value, timestamp: 0n });
                    },
                }),
            ],
            catalog,
            remoteResolver: singleTransportResolver(createGrpcTransport({ baseUrl })),
            outgoingInterceptors: [createOtelClientInterceptor({ serverAddress: "test-server" })],
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(res.message, "remote");
        assertOneClientSpan();
    });

    it("standalone createCatalogClient({ outgoingInterceptors }): exactly one finished CLIENT span", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: singleTransportResolver(createGrpcTransport({ baseUrl })),
            outgoingInterceptors: [createOtelClientInterceptor({ serverAddress: "test-server" })],
        });
        const item = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "standalone", sequence: 1 }));
        assert.strictEqual(item.value, "standalone");
        assertOneClientSpan();
    });
});
