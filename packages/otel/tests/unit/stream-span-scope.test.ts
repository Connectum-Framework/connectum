/**
 * Server span scope inside streaming handlers.
 *
 * A streaming handler body is a lazily started async generator: it runs when
 * the transport pulls the first response message, long after the interceptor's
 * `startActiveSpan` callback has returned. These tests pin that the server
 * span is still the active span in every phase of such a handler, that child
 * spans created by the handler are parented to it, that the scope never leaks
 * into the code that consumes the stream or into a concurrent stream, and that
 * nothing retains a finished span.
 */

process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { create } from "@bufbuild/protobuf";
import { type Client, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { InMemorySpanCollector, type NormalizedSpan } from "@connectum/testing";
import { context, type Span, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

type Transport = "local" | "http";
const TRANSPORTS: Transport[] = ["local", "http"];

const SERVER_SPAN_NAMES = {
    server: "streaming.v1.StreamingService/Server",
    bidi: "streaming.v1.StreamingService/Bidi",
} as const;

/** What a handler observed in one phase of its body. */
interface Observation {
    phase: string;
    /** Span id of `trace.getActiveSpan()` at that moment, undefined when none is active. */
    active: string | undefined;
    /** Span id of a span the handler started with `startActiveSpan` at that moment, and its parent. */
    childParent: string | undefined;
}

const activeId = () => trace.getActiveSpan()?.spanContext().spanId;

/**
 * Records the active span and creates a child span the way `traced()` does,
 * so the parent link of handler-created spans is observed, not inferred.
 */
function observe(into: Observation[], phase: string): void {
    const active = activeId();
    let childParent: string | undefined;
    trace.getTracer("stream-span-scope-test").startActiveSpan(`child:${phase}`, (child: Span) => {
        childParent = (child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
        child.end();
    });
    into.push({ phase, active, childParent });
}

function buildService(into: Map<string, Observation[]>) {
    const bucket = (key: string) => {
        let list = into.get(key);
        if (!list) {
            list = [];
            into.set(key, list);
        }
        return list;
    };
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value }),
        client: async (requests) => {
            let total = 0;
            for await (const _ of requests) total++;
            return { total };
        },
        async *server(req) {
            const seen = bucket(req.value);
            observe(seen, "start");
            try {
                await nextImmediate();
                observe(seen, "after-await");
                yield create(ItemSchema, { value: "a", sequence: 1 });
                observe(seen, "after-yield");
                await nextImmediate();
                yield create(ItemSchema, { value: "b", sequence: 2 });
                observe(seen, "after-second-yield");
            } finally {
                observe(seen, "finally");
            }
        },
        async *bidi(requests) {
            let seen: Observation[] | undefined;
            try {
                for await (const item of requests) {
                    seen ??= bucket(item.value);
                    if (seen.length === 0) observe(seen, "start");
                    await nextImmediate();
                    observe(seen, "after-await");
                    yield create(ItemSchema, { value: item.value, sequence: item.sequence });
                    observe(seen, "after-yield");
                }
            } finally {
                observe(seen ?? bucket("none"), "finally");
            }
        },
    });
}

async function* oneItem(value: string) {
    yield create(ItemSchema, { value });
}

describe("server span scope inside streaming handlers", () => {
    let collector: InMemorySpanCollector;

    beforeEach(async () => {
        collector = new InMemorySpanCollector();
        await shutdownProvider();
        trace.disable();
        trace.setGlobalTracerProvider(collector.provider);
    });

    afterEach(async () => {
        await shutdownProvider();
        trace.disable();
        await collector.dispose();
    });

    async function withClient<T>(
        transport: Transport,
        into: Map<string, Observation[]>,
        body: (client: Client<typeof StreamingService>) => Promise<T>,
        interceptors = [createOtelInterceptor({ recordMessages: true })],
        clientInterceptors: Interceptor[] = [],
    ): Promise<T> {
        const server = createServer({
            services: [buildService(into)],
            interceptors,
            port: 0,
            allowHTTP1: false,
            shutdown: { timeout: 500 },
        });
        await server.start();
        try {
            const client =
                transport === "local"
                    ? createClient(StreamingService, createLocalTransport(server, { interceptors: clientInterceptors }))
                    : createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}`, interceptors: clientInterceptors }));
            return await body(client);
        } finally {
            await server.stop();
        }
    }

    function serverSpan(name: string): NormalizedSpan {
        const found = collector.flush().filter((s) => s.name === name && s.kind === SpanKind.SERVER);
        assert.strictEqual(found.length, 1, `exactly one server span named ${name}, got ${found.length}`);
        return found[0] as NormalizedSpan;
    }

    function assertScoped(observations: Observation[] | undefined, expectedPhases: string[], span: NormalizedSpan): void {
        assert.ok(observations, "handler ran");
        assert.deepStrictEqual(
            observations.map((o) => o.phase),
            expectedPhases,
        );
        for (const o of observations) {
            assert.strictEqual(o.active, span.spanId, `server span active in phase ${o.phase}`);
            assert.strictEqual(o.childParent, span.spanId, `child span started in phase ${o.phase} is parented to the server span`);
        }
    }

    for (const transport of TRANSPORTS) {
        describe(transport, () => {
            it("server-stream: server span is active in every handler phase", { timeout: 30_000 }, async () => {
                const into = new Map<string, Observation[]>();
                await withClient(transport, into, async (client) => {
                    for await (const _ of client.server(create(ItemSchema, { value: "k" }))) {
                        /* drain */
                    }
                });
                assertScoped(into.get("k"), ["start", "after-await", "after-yield", "after-second-yield", "finally"], serverSpan(SERVER_SPAN_NAMES.server));
            });

            it("bidi: server span is active in every handler phase", { timeout: 30_000 }, async () => {
                const into = new Map<string, Observation[]>();
                await withClient(transport, into, async (client) => {
                    for await (const _ of client.bidi(oneItem("k"))) {
                        /* drain */
                    }
                });
                assertScoped(into.get("k"), ["start", "after-await", "after-yield", "finally"], serverSpan(SERVER_SPAN_NAMES.bidi));
            });

            it("server-stream: cleanup runs after a client abort (and under the server span over HTTP)", { timeout: 30_000 }, async () => {
                const into = new Map<string, Observation[]>();
                await withClient(transport, into, async (client) => {
                    const controller = new AbortController();
                    try {
                        for await (const _ of client.server(create(ItemSchema, { value: "k" }), { signal: controller.signal })) {
                            controller.abort();
                        }
                    } catch {
                        // the aborted call reports its cancellation to the consumer
                    }
                    // The handler's cleanup is driven asynchronously by the abort.
                    const deadline = Date.now() + 5_000;
                    while (!into.get("k")?.some((o) => o.phase === "finally") && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                });
                const observations = into.get("k");
                const started = observations?.find((o) => o.phase === "start");
                const cleaned = observations?.find((o) => o.phase === "finally");
                assert.ok(started?.active, "the handler started under a span");
                assert.ok(cleaned, "handler finally block ran after the abort");
                if (transport === "http") {
                    // Over HTTP the transport pulls the stream to its end through the scoped
                    // iterator, so the cleanup runs under the span and the span ends.
                    assert.strictEqual(cleaned.active, started.active, "cleanup runs under the span the handler started under");
                    assert.strictEqual(serverSpan(SERVER_SPAN_NAMES.server).spanId, started.active);
                }
                // In-process, the abort listener of the stream bridge finishes the handler
                // directly, outside any iterator step this interceptor can scope; the context
                // of that cleanup is the bridge's responsibility, not asserted here.
            });

            it("unary: handler keeps the server span active (unchanged)", { timeout: 30_000 }, async () => {
                const seen: string[] = [];
                const svc = defineService(StreamingService, {
                    echo: async (req) => {
                        seen.push(activeId() ?? "none");
                        await nextImmediate();
                        seen.push(activeId() ?? "none");
                        return create(ItemSchema, { value: req.value });
                    },
                    server: async function* () {},
                    client: async () => ({ total: 0 }),
                    bidi: async function* () {},
                });
                const server = createServer({ services: [svc], interceptors: [createOtelInterceptor()], port: 0, allowHTTP1: false, shutdown: { timeout: 500 } });
                await server.start();
                try {
                    const client =
                        transport === "local"
                            ? server.localClient(StreamingService)
                            : createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
                    await client.echo(create(ItemSchema, { value: "x" }));
                } finally {
                    await server.stop();
                }
                const span = serverSpan("streaming.v1.StreamingService/Echo");
                assert.deepStrictEqual(seen, [span.spanId, span.spanId]);
            });

            for (const withClientSpan of [false, true]) {
                it(`the producer of a request stream keeps the caller's context, not the server span (client interceptor: ${withClientSpan})`, { timeout: 30_000 }, async () => {
                    const into = new Map<string, Observation[]>();
                    const producerSaw: Array<string | undefined> = [];
                    async function* producer() {
                        for (let i = 0; i < 2; i++) {
                            producerSaw.push(activeId());
                            await nextImmediate();
                            yield create(ItemSchema, { value: "k" });
                        }
                    }
                    const callerSpan = collector.provider.getTracer("caller").startSpan("caller");
                    const clientInterceptors = withClientSpan ? [createOtelClientInterceptor({ serverAddress: "localhost" })] : [];
                    await withClient(
                        transport,
                        into,
                        async (client) => {
                            await context.with(trace.setSpan(context.active(), callerSpan), async () => {
                                await client.client(producer());
                                for await (const _ of client.bidi(producer())) {
                                    /* drain */
                                }
                            });
                        },
                        undefined,
                        clientInterceptors,
                    );
                    callerSpan.end();
                    const spans = collector.flush();
                    const serverIds = new Set(spans.filter((s) => s.kind === SpanKind.SERVER).map((s) => s.spanId));
                    const clientIds = new Set(spans.filter((s) => s.kind === SpanKind.CLIENT).map((s) => s.spanId));
                    assert.strictEqual(serverIds.size, 2);
                    assert.strictEqual(producerSaw.length, 4);
                    for (const id of producerSaw) {
                        assert.ok(id !== undefined && !serverIds.has(id), "the producer does not run under a server span");
                        if (withClientSpan) assert.ok(clientIds.has(id), "the producer runs under the client span of its own call");
                        else assert.strictEqual(id, callerSpan.spanContext().spanId, "the producer runs under the caller's span");
                    }
                });
            }

            it("the scope does not leak into the stream consumer", { timeout: 30_000 }, async () => {
                const into = new Map<string, Observation[]>();
                const consumerSpan = collector.provider.getTracer("consumer").startSpan("consumer");
                const consumerCtx = trace.setSpan(context.active(), consumerSpan);
                await withClient(transport, into, async (client) => {
                    await context.with(consumerCtx, async () => {
                        const consumerSeen: Array<string | undefined> = [];
                        for await (const _ of client.server(create(ItemSchema, { value: "k" }))) {
                            consumerSeen.push(activeId());
                        }
                        for await (const _ of client.bidi(oneItem("k2"))) {
                            consumerSeen.push(activeId());
                        }
                        consumerSeen.push(activeId());
                        assert.ok(consumerSeen.length >= 3);
                        for (const id of consumerSeen) {
                            assert.strictEqual(id, consumerSpan.spanContext().spanId, "consumer keeps its own active span");
                        }
                    });
                });
                consumerSpan.end();
                assert.strictEqual(activeId(), undefined, "nothing is active after the stream");
            });

            it("concurrent streams never see each other's span", { timeout: 60_000 }, async () => {
                const into = new Map<string, Observation[]>();
                await withClient(transport, into, async (client) => {
                    await Promise.all(
                        Array.from({ length: 8 }, async (_, i) => {
                            const drain = async (it: AsyncIterable<unknown>) => {
                                for await (const _ of it) {
                                    /* drain */
                                }
                            };
                            if (i % 2 === 0) await drain(client.server(create(ItemSchema, { value: `s${i}` })));
                            else await drain(client.bidi(oneItem(`b${i}`)));
                        }),
                    );
                });
                const spans = collector.flush().filter((s) => s.kind === SpanKind.SERVER);
                assert.strictEqual(spans.length, 8);
                const seenSpanIds = new Set<string>();
                for (const [key, observations] of into) {
                    const owners = new Set(observations.map((o) => o.active));
                    assert.strictEqual(owners.size, 1, `stream ${key} saw a single span, got ${[...owners].join(",")}`);
                    const [owner] = [...owners];
                    assert.ok(owner && spans.some((s) => s.spanId === owner), `stream ${key} saw a server span`);
                    assert.ok(!seenSpanIds.has(owner), `server span of ${key} is not shared with another stream`);
                    seenSpanIds.add(owner);
                }
                assert.strictEqual(seenSpanIds.size, 8);
            });
        });
    }
});

describe("server span retention", () => {
    it("no finished span stays reachable through the stream scope", { timeout: 60_000 }, async () => {
        setFlagsFromString("--expose-gc");
        const gc = runInNewContext("gc") as () => void;

        const refs: WeakRef<Span>[] = [];
        // A tracer provider that keeps no span: the collector would otherwise
        // hold every finished span and hide a leak.
        const provider = new BasicTracerProvider({
            spanProcessors: [
                {
                    onStart: (span) => {
                        refs.push(new WeakRef(span as unknown as Span));
                    },
                    onEnd: () => {},
                    forceFlush: async () => {},
                    shutdown: async () => {},
                },
            ],
        });
        await shutdownProvider();
        trace.disable();
        trace.setGlobalTracerProvider(provider);

        const into = new Map<string, Observation[]>();
        const server = createServer({
            services: [buildService(into)],
            interceptors: [createOtelInterceptor()],
            port: 0,
            allowHTTP1: false,
            shutdown: { timeout: 500 },
        });
        await server.start();
        try {
            const client = server.localClient(StreamingService);
            for (let i = 0; i < 20; i++) {
                for await (const _ of client.server(create(ItemSchema, { value: `s${i}` }))) {
                    /* drain */
                }
                for await (const _ of client.bidi(oneItem(`b${i}`))) {
                    /* drain */
                }
            }
        } finally {
            await server.stop();
        }
        await shutdownProvider();
        trace.disable();
        await provider.shutdown();
        into.clear();

        let alive = refs.length;
        for (let attempt = 0; attempt < 20 && alive > 0; attempt++) {
            await nextImmediate();
            await new Promise((resolve) => setTimeout(resolve, 20));
            gc();
            alive = refs.filter((r) => r.deref() !== undefined).length;
        }
        assert.ok(refs.length >= 40, `server spans were created (${refs.length})`);
        assert.strictEqual(alive, 0, `${alive} of ${refs.length} spans are still reachable after the streams finished`);
    });
});
