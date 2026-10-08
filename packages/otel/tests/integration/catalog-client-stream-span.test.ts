/**
 * A catalog client-streaming call must produce exactly one finished client span.
 *
 * `createOtelClientInterceptor` ends a streaming call's span in the `finally`
 * of the generator that wraps the response stream, so the span finishes only
 * when the response stream is driven to its end (or errors). A catalog
 * `close()` that stops reading at the first response leaves the span started
 * but never ended: the SDK sees one `onStart` and no `onEnd`, and nothing is
 * exported. These tests count the span-processor callbacks and the exported
 * spans of a real SDK tracer provider (`onStart` / `onEnd` / export), because a
 * spy on the interceptor would not notice a span that never finishes.
 *
 * Two routes are covered: the handler `ctx.stream` reaching a locally mounted
 * service through the server's `outgoingInterceptors` chain, and the
 * standalone catalog client over a real gRPC/HTTP/2 connection whose transport
 * carries the interceptor (the documented way to instrument a remote route).
 */

// MUST run before any @connectum/otel import resolves transitively.
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { CallOptions, ClientStreamHandle } from "@connectum/core";
import { createCatalogClient, createServer, defineCatalog, defineService, singleTransportResolver } from "@connectum/core";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { type Count, CountSchema, type Item, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const CLIENT_STREAM = "streaming.v1.StreamingService/Client";

/** Counts the callbacks the SDK makes into a span processor. */
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
let provider: BasicTracerProvider;

beforeEach(async () => {
    counter = new CountingProcessor();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [counter, new SimpleSpanProcessor(exporter)] });
    // The interceptor caches its tracer against the global provider: drop any
    // cached one and swap the global before the interceptor is created.
    await shutdownProvider();
    trace.disable();
    trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
    await shutdownProvider();
    trace.disable();
    await provider.shutdown();
});

function finishedClientSpans(): ReadableSpan[] {
    return exporter.getFinishedSpans();
}

/** Asserts the SDK saw exactly one span start, end and export. */
function assertOneSpan(): ReadableSpan {
    assert.strictEqual(counter.started, 1, "onStart count");
    assert.strictEqual(counter.ended, 1, "onEnd count");
    const spans = finishedClientSpans();
    assert.strictEqual(spans.length, 1, "exported span count");
    return spans[0] as ReadableSpan;
}

function newCatalog() {
    return defineCatalog({
        [StreamingService.typeName]: StreamingService,
        [EchoService.typeName]: EchoService,
    });
}

describe("catalog client-stream span — ctx.stream to a local service through outgoingInterceptors", () => {
    function makeServer(clientHandler: (requests: AsyncIterable<Item>) => Promise<Count>, onResult: (outcome: { value?: Count; error?: unknown }) => void) {
        return createServer({
            services: [
                defineService(StreamingService, {
                    echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
                    async *server() {},
                    client: clientHandler,
                    async *bidi() {},
                }),
                defineService(EchoService, {
                    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    async secureEcho(_req, ctx) {
                        const open = ctx.stream as unknown as (method: string) => () => ClientStreamHandle<unknown, Count>;
                        try {
                            const handle = open(CLIENT_STREAM)();
                            handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
                            handle.send(create(ItemSchema, { value: "b", sequence: 1 }));
                            onResult({ value: await handle.close() });
                        } catch (error) {
                            onResult({ error });
                        }
                        return create(EchoResponseSchema, { message: "done", timestamp: 0n });
                    },
                }),
            ],
            catalog: newCatalog(),
            outgoingInterceptors: [createOtelClientInterceptor({ serverAddress: "test-server" })],
        });
    }

    it("a successful call starts, ends and exports exactly one span with OK status", async () => {
        let outcome: { value?: Count; error?: unknown } | undefined;
        const server = makeServer(
            async (requests) => {
                let total = 0;
                for await (const _ of requests) total++;
                return create(CountSchema, { total });
            },
            (o) => {
                outcome = o;
            },
        );
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
        assert.strictEqual(outcome?.error, undefined);
        assert.strictEqual(outcome?.value?.total, 2);
        const span = assertOneSpan();
        assert.strictEqual(span.status.code, SpanStatusCode.OK);
    });

    it("a failed call rejects and ends exactly one span with ERROR status", async () => {
        let outcome: { value?: Count; error?: unknown } | undefined;
        const server = makeServer(
            async (requests) => {
                for await (const _ of requests) {
                    // consume all requests, then fail
                }
                throw new ConnectError("handler failed", Code.FailedPrecondition);
            },
            (o) => {
                outcome = o;
            },
        );
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
        assert.ok(outcome?.error instanceof ConnectError && outcome.error.code === Code.FailedPrecondition, `expected FailedPrecondition, got ${String(outcome?.error)}`);
        const span = assertOneSpan();
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    });
});

/** One gRPC length-prefixed message frame. */
function grpcFrame(message: Count): Buffer {
    const payload = toBinary(CountSchema, message);
    const frame = Buffer.alloc(5 + payload.length);
    frame.writeUInt32BE(payload.length, 1);
    frame.set(payload, 5);
    return frame;
}

/**
 * A gRPC server that answers any call with one response, then the given
 * terminal status — or, for `"never"`, never sends the terminal status.
 */
async function serveOneResponseThen(status: { code: number; message?: string } | "never", use: (baseUrl: string) => Promise<void>): Promise<void> {
    const http2: Http2Server = createHttp2Server();
    const sessions = new Set<ServerHttp2Session>();
    http2.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
    });
    http2.on("stream", (stream: ServerHttp2Stream) => {
        stream.resume();
        stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
        stream.write(grpcFrame(create(CountSchema, { total: 1 })));
        if (status === "never") return;
        stream.on("wantTrailers", () => {
            const trailers: Record<string, string> = { "grpc-status": String(status.code) };
            if (status.message !== undefined) trailers["grpc-message"] = encodeURIComponent(status.message);
            stream.sendTrailers(trailers);
        });
        stream.end();
    });
    await new Promise<void>((resolve) => http2.listen(0, "127.0.0.1", resolve));
    const { port } = http2.address() as AddressInfo;
    try {
        await use(`http://127.0.0.1:${port}`);
    } finally {
        for (const session of sessions) session.destroy();
        await new Promise<void>((resolve) => http2.close(() => resolve()));
    }
}

describe("catalog client-stream span — standalone catalog client over gRPC with a transport-level interceptor", () => {
    function clientFor(baseUrl: string) {
        const transport = createGrpcTransport({ baseUrl, interceptors: [createOtelClientInterceptor({ serverAddress: "test-server" })] });
        const client = createCatalogClient({ catalog: newCatalog(), resolver: singleTransportResolver(transport) });
        return client.stream as unknown as (method: string) => (options?: CallOptions) => ClientStreamHandle<unknown, Count>;
    }

    it("a response followed by OK status starts, ends and exports exactly one span with OK status", async () => {
        await serveOneResponseThen({ code: 0 }, async (baseUrl) => {
            const handle = clientFor(baseUrl)(CLIENT_STREAM)();
            handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
            const res = await handle.close();
            assert.strictEqual(res.total, 1);
        });
        const span = assertOneSpan();
        assert.strictEqual(span.status.code, SpanStatusCode.OK);
    });

    it("a response followed by a failure status rejects and ends exactly one span with ERROR status", async () => {
        await serveOneResponseThen({ code: Code.DataLoss, message: "late failure" }, async (baseUrl) => {
            const handle = clientFor(baseUrl)(CLIENT_STREAM)();
            handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
            await assert.rejects(
                () => handle.close(),
                (err: unknown) => err instanceof ConnectError && err.code === Code.DataLoss && err.rawMessage === "late failure",
            );
        });
        const span = assertOneSpan();
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    });

    it("a call canceled while the terminal status is pending rejects as canceled and ends exactly one span with ERROR status", async () => {
        await serveOneResponseThen("never", async (baseUrl) => {
            const controller = new AbortController();
            const handle = clientFor(baseUrl)(CLIENT_STREAM)({ signal: controller.signal });
            handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
            const closing = handle.close();
            const assertion = assert.rejects(closing, (err: unknown) => err instanceof ConnectError && err.code === Code.Canceled);
            // Give the response frame time to arrive, so the abort lands while
            // the call waits for its terminal status.
            for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(counter.ended, 0, "the span must still be open while the terminal status is pending");
            controller.abort();
            await assertion;
        });
        const span = assertOneSpan();
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    });
});
