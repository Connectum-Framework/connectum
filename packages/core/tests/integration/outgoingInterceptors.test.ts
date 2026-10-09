/**
 * `outgoingInterceptors` — one client-side chain on every catalog route.
 *
 * The chain configured on `createServer({ outgoingInterceptors })` must run
 * exactly once per call for every RPC kind, whether the target is mounted on
 * the same server (in-process), reached over TCP in another server, or served
 * by an opaque resolver transport — and on both call surfaces, `ctx.call` /
 * `ctx.stream` and `server.client()`. The standalone `createCatalogClient`
 * applies its own explicit chain the same way.
 *
 * Each test records three observations per call: how many times the chain
 * ran, whether a header set by the chain reached the receiver, and (for
 * streams) whether the chain's response wrapper ran to completion, which is
 * what lets an instrumentation interceptor finish its span.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { type Client, Code, ConnectError, createClient, createRouterTransport, type Interceptor, type ServiceImpl, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createCatalogClient } from "../../src/catalogClient.ts";
import type { Context } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { mapResolver, singleTransportResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import type { Server } from "../../src/types.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Count, CountSchema, type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: Item; response: Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: Item; response: Item; kind: "bidi" };
    }
}

const SEEN_HEADER = "x-outgoing-seen";

/**
 * The receiving StreamingService: every response reports whether the request
 * carried the header the outgoing chain sets, so a test can tell "the chain
 * ran somewhere" from "the chain's effect reached the wire".
 */
const targetImpl: ServiceImpl<typeof StreamingService> = {
    echo: (req, ctx) => create(ItemSchema, { value: `${req.value}|${ctx.requestHeader.get(SEEN_HEADER) ?? "none"}`, sequence: req.sequence }),
    async *server(req, ctx) {
        const seen = ctx.requestHeader.get(SEEN_HEADER) ?? "none";
        for (let i = 0; i < req.sequence; i++) {
            yield create(ItemSchema, { value: `${req.value}-${i}|${seen}`, sequence: i });
        }
    },
    async client(requests, ctx) {
        let total = 0;
        for await (const _item of requests) total += 1;
        // 100 marks "header seen" so the single numeric response carries both facts.
        return create(CountSchema, { total: total + (ctx.requestHeader.get(SEEN_HEADER) === "yes" ? 100 : 0) });
    },
    async *bidi(requests, ctx) {
        const seen = ctx.requestHeader.get(SEEN_HEADER) ?? "none";
        for await (const item of requests) {
            yield create(ItemSchema, { value: `${item.value}|${seen}`, sequence: item.sequence });
        }
    },
};

function streamingTarget() {
    return defineService(StreamingService, targetImpl);
}

interface Spy {
    readonly interceptor: Interceptor;
    /** Number of times the chain was entered. */
    calls: number;
    /** Number of streaming response wrappers that ran to completion (their `finally`). */
    completed: number;
    urls: string[];
}

/** An outgoing interceptor that counts, tags the request and wraps streaming responses. */
function makeSpy(): Spy {
    const spy: Spy = {
        calls: 0,
        completed: 0,
        urls: [],
        interceptor: (next) => async (req) => {
            spy.calls += 1;
            spy.urls.push(req.url);
            req.header.set(SEEN_HEADER, "yes");
            const res = await next(req);
            if (!res.stream) return res;
            const inner = res.message;
            return {
                ...res,
                message: (async function* () {
                    try {
                        yield* inner;
                    } finally {
                        spy.completed += 1;
                    }
                })(),
            };
        },
    };
    return spy;
}

type Caller = (ctx: Context) => Promise<string>;

/** EchoService whose `secureEcho` runs the scenario and returns its summary. */
function callerService(run: Caller) {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        secureEcho: async (_req: EchoRequest, ctx: Context): Promise<EchoResponse> => create(EchoResponseSchema, { message: await run(ctx), timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

const catalog = defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService });

/** Run `scenario` inside a handler on `server` and return its summary. */
async function inHandler(server: Server, scenario: Caller): Promise<string> {
    server.addService(callerService(scenario));
    const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
    return res.message;
}

/** The four RPC kinds over the handler `ctx`, each producing a summary string. */
const ctxKinds: Record<string, Caller> = {
    unary: async (ctx) => (await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "u", sequence: 0 }))).value,
    server: async (ctx) => {
        const out: string[] = [];
        for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 2 }))) out.push(item.value);
        return out.join(",");
    },
    client: async (ctx) => {
        const handle = ctx.stream("streaming.v1.StreamingService/Client")();
        handle.send(create(ItemSchema, { value: "c", sequence: 0 }));
        handle.send(create(ItemSchema, { value: "c", sequence: 1 }));
        return String((await handle.close()).total);
    },
    bidi: async (ctx) => {
        const handle = ctx.stream("streaming.v1.StreamingService/Bidi")();
        handle.send(create(ItemSchema, { value: "b", sequence: 0 }));
        handle.close();
        const out: string[] = [];
        for await (const item of handle.responses) out.push(item.value);
        return out.join(",");
    },
};

const expected: Record<string, string> = { unary: "u|yes", server: "s-0|yes,s-1|yes", client: "102", bidi: "b|yes" };

/** The same four kinds over a `server.client()`-style Connect client. */
async function viaClient(c: Client<typeof StreamingService>, kind: string): Promise<string> {
    switch (kind) {
        case "unary":
            return (await c.echo(create(ItemSchema, { value: "u", sequence: 0 }))).value;
        case "server": {
            const out: string[] = [];
            for await (const item of c.server(create(ItemSchema, { value: "s", sequence: 2 }))) out.push(item.value);
            return out.join(",");
        }
        case "client":
            return String(
                (
                    await c.client(
                        (async function* () {
                            yield create(ItemSchema, { value: "c", sequence: 0 });
                            yield create(ItemSchema, { value: "c", sequence: 1 });
                        })(),
                    )
                ).total,
            );
        default: {
            const out: string[] = [];
            for await (const item of c.bidi(
                (async function* () {
                    yield create(ItemSchema, { value: "b", sequence: 0 });
                })(),
            ))
                out.push(item.value);
            return out.join(",");
        }
    }
}

// ---------------------------------------------------------------------------
// Routes: a TCP server in this process standing in for "another process", and
// an opaque router transport standing in for any resolver-built transport.
// ---------------------------------------------------------------------------

let tcpServer: Server;
let tcpTransport: Transport;

before(async () => {
    // Short shutdown budget: the gRPC client transports of this file keep their
    // HTTP/2 sessions open, and `stop()` must not wait the default 30 s for them.
    tcpServer = createServer({ services: [streamingTarget()], port: 0, host: "127.0.0.1", allowHTTP1: false, shutdown: { timeout: 200 } });
    await tcpServer.start();
    tcpTransport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${tcpServer.address?.port}` });
});
after(async () => {
    await tcpServer.stop();
});

function opaqueTransport(): Transport {
    return createRouterTransport((router) => router.service(StreamingService, targetImpl));
}

const routes: Record<string, () => { local: boolean; transport?: () => Transport }> = {
    "local (same server)": () => ({ local: true }),
    "remote (TCP, other server)": () => ({ local: false, transport: () => tcpTransport }),
    "remote (opaque router transport)": () => ({ local: false, transport: opaqueTransport }),
};

function serverFor(route: { local: boolean; transport?: () => Transport }, interceptors: Interceptor[]): Server {
    return createServer({
        services: route.local ? [streamingTarget()] : [],
        catalog,
        outgoingInterceptors: interceptors,
        ...(route.transport ? { remoteResolver: singleTransportResolver(route.transport()) } : {}),
    });
}

describe("outgoingInterceptors — every route, every kind, both surfaces", () => {
    for (const [routeName, makeRoute] of Object.entries(routes)) {
        for (const kind of Object.keys(ctxKinds)) {
            it(`${routeName} / ${kind} / ctx: chain runs once, its header reaches the receiver, its stream wrapper completes`, async () => {
                const spy = makeSpy();
                const server = serverFor(makeRoute(), [spy.interceptor]);
                const summary = await inHandler(server, ctxKinds[kind] as Caller);
                assert.strictEqual(summary, expected[kind]);
                assert.strictEqual(spy.calls, 1, "chain must run exactly once");
                assert.strictEqual(spy.completed, kind === "unary" ? 0 : 1, "streaming response wrapper must run to completion once");
            });

            it(`${routeName} / ${kind} / server.client(): chain runs once, its header reaches the receiver`, async () => {
                const spy = makeSpy();
                const server = serverFor(makeRoute(), [spy.interceptor]);
                const summary = await viaClient(server.client(StreamingService), kind);
                assert.strictEqual(summary, expected[kind]);
                assert.strictEqual(spy.calls, 1, "chain must run exactly once");
                assert.strictEqual(spy.completed, kind === "unary" ? 0 : 1);
            });
        }
    }

    it("localClient() stays plain: the chain does not run", async () => {
        const spy = makeSpy();
        const server = serverFor(routes["local (same server)"]?.() as never, [spy.interceptor]);
        const res = await server.localClient(StreamingService).echo(create(ItemSchema, { value: "u", sequence: 0 }));
        assert.strictEqual(res.value, "u|none");
        assert.strictEqual(spy.calls, 0);
    });

    it("source order: the first interceptor is outermost, the resolver transport's own interceptors run inside", async () => {
        const order: string[] = [];
        const tag = (name: string): Interceptor => (next) => (req) => {
            order.push(name);
            const prev = req.header.get("x-order");
            req.header.set("x-order", prev ? `${prev},${name}` : name);
            return next(req);
        };
        const transportOwned = createRouterTransport(
            (router) =>
                router.service(StreamingService, {
                    echo: (req, ctx) => create(ItemSchema, { value: ctx.requestHeader.get("x-order") ?? "", sequence: req.sequence }),
                    async *server() {},
                    client: async () => create(CountSchema, { total: 0 }),
                    async *bidi() {},
                }),
            { transport: { interceptors: [tag("transport")] } },
        );
        const server = createServer({ services: [], catalog, outgoingInterceptors: [tag("first"), tag("second")], remoteResolver: singleTransportResolver(transportOwned) });
        const res = await server.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        assert.strictEqual(res.value, "first,second,transport");
        assert.deepStrictEqual(order, ["first", "second", "transport"]);
    });

    it("empty chain: the resolver's transport is cached as is (no wrapper, legacy behaviour byte for byte)", () => {
        const remote = opaqueTransport();
        const server = createServer({ services: [], catalog, remoteResolver: singleTransportResolver(remote) }) as unknown as {
            _resolveRemoteTransport(typeName: string): Transport | null;
        };
        assert.strictEqual(server._resolveRemoteTransport(StreamingService.typeName), remote);
    });

    it("two servers sharing one Transport keep their own chains", async () => {
        const remote = opaqueTransport();
        const a = makeSpy();
        const b = makeSpy();
        const serverA = createServer({ services: [], catalog, outgoingInterceptors: [a.interceptor], remoteResolver: singleTransportResolver(remote) });
        const serverB = createServer({ services: [], catalog, outgoingInterceptors: [b.interceptor], remoteResolver: singleTransportResolver(remote) });
        await serverA.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        await serverA.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        await serverB.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        assert.strictEqual(a.calls, 2);
        assert.strictEqual(b.calls, 1);
    });

    it("the chain observes the synthetic catalog URL on a resolver route and the in-memory URL on the local route", async () => {
        const spy = makeSpy();
        const remote = createServer({ services: [], catalog, outgoingInterceptors: [spy.interceptor], remoteResolver: singleTransportResolver(opaqueTransport()) });
        await remote.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        const local = createServer({ services: [streamingTarget()], catalog, outgoingInterceptors: [spy.interceptor] });
        await local.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }));
        assert.deepStrictEqual(spy.urls, ["https://catalog/streaming.v1.StreamingService/Echo", "https://in-memory/streaming.v1.StreamingService/Echo"]);
    });
});

describe("outgoingInterceptors — call context is preserved on a resolver route", () => {
    it("a call parked in a slow interceptor expires at its deadline (the chain's req.signal is linked to it)", async () => {
        const slow: Interceptor = (next) => async (req) => {
            await sleep(80);
            return next(req);
        };
        const slowTarget = createRouterTransport((router) =>
            router.service(StreamingService, {
                echo: async (req) => {
                    await sleep(60);
                    return create(ItemSchema, { value: req.value, sequence: 0 });
                },
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        const server = createServer({ services: [], catalog, outgoingInterceptors: [slow], remoteResolver: singleTransportResolver(slowTarget) });
        await assert.rejects(
            inHandler(server, async (ctx) => (await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "", sequence: 0 }), { timeoutMs: 100 })).value),
            (err: unknown) => err instanceof ConnectError && err.code === Code.DeadlineExceeded,
        );
    });

    it("timeoutMs <= 0 means no deadline, as on a Connect transport: the call is not expired at once", async () => {
        const spy = makeSpy();
        const slowTarget = createRouterTransport((router) =>
            router.service(StreamingService, {
                echo: async (req) => {
                    await sleep(30);
                    return create(ItemSchema, { value: req.value, sequence: 0 });
                },
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        const server = createServer({ services: [], catalog, outgoingInterceptors: [spy.interceptor], remoteResolver: singleTransportResolver(slowTarget) });
        const res = await server.client(StreamingService).echo(create(ItemSchema, { value: "zero", sequence: 0 }), { timeoutMs: 0 });
        assert.strictEqual(res.value, "zero");
        assert.strictEqual(spy.calls, 1);
    });

    it("a failure after N streamed messages reaches the caller with its code and metadata", async () => {
        const spy = makeSpy();
        const failing = createRouterTransport((router) =>
            router.service(StreamingService, {
                echo: (req) => create(ItemSchema, { value: req.value, sequence: 0 }),
                async *server(req) {
                    yield create(ItemSchema, { value: `${req.value}-0`, sequence: 0 });
                    yield create(ItemSchema, { value: `${req.value}-1`, sequence: 1 });
                    throw new ConnectError("quota", Code.ResourceExhausted, new Headers({ "x-reason": "quota" }));
                },
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        // Oracle: what a plain Connect client sees from the same transport.
        async function drain(items: AsyncIterable<Item>): Promise<{ received: string[]; code: Code; reason: string | null }> {
            const received: string[] = [];
            try {
                for await (const item of items) received.push(item.value);
            } catch (err) {
                assert.ok(err instanceof ConnectError);
                return { received, code: err.code, reason: err.metadata.get("x-reason") };
            }
            assert.fail("the stream must fail");
        }
        const native = await drain(createClient(StreamingService, failing).server(create(ItemSchema, { value: "s", sequence: 0 })));
        const server = createServer({ services: [], catalog, outgoingInterceptors: [spy.interceptor], remoteResolver: singleTransportResolver(failing) });
        let viaChain: Awaited<ReturnType<typeof drain>> | undefined;
        await inHandler(server, async (ctx) => {
            viaChain = await drain(ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 0 })));
            return "done";
        });
        assert.deepStrictEqual(native.received, ["s-0", "s-1"], "messages before the failure are delivered");
        assert.strictEqual(native.code, Code.ResourceExhausted);
        assert.deepStrictEqual(viaChain, native, "the chain must surface the same outcome (messages, code, error metadata) as a plain Connect client");
        assert.strictEqual(spy.completed, 1, "the chain's response wrapper finishes on the terminal failure");
    });

    it("server.client() on a resolver route still delivers response trailers to onTrailer", async () => {
        const spy = makeSpy();
        const trailing = createRouterTransport((router) =>
            router.service(StreamingService, {
                echo: (req, ctx) => {
                    ctx.responseTrailer.set("x-trail", "1");
                    return create(ItemSchema, { value: req.value, sequence: 0 });
                },
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        const server = createServer({ services: [], catalog, outgoingInterceptors: [spy.interceptor], remoteResolver: singleTransportResolver(trailing) });
        let trailer: string | null = null;
        await server.client(StreamingService).echo(create(ItemSchema, { value: "t", sequence: 0 }), { onTrailer: (t) => void (trailer = t.get("x-trail")) });
        assert.strictEqual(trailer, "1");
    });

    it("the inner transport receives the remaining budget, not the original one (this is what starts the budget before the chain)", async () => {
        let seenTimeout: string | null = null;
        const slow: Interceptor = (next) => async (req) => {
            await sleep(50);
            return next(req);
        };
        const target = createRouterTransport((router) =>
            router.service(StreamingService, {
                echo: (req, ctx) => {
                    seenTimeout = ctx.requestHeader.get("connect-timeout-ms");
                    return create(ItemSchema, { value: req.value, sequence: 0 });
                },
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            }),
        );
        const server = createServer({ services: [], catalog, outgoingInterceptors: [slow], remoteResolver: singleTransportResolver(target) });
        await server.client(StreamingService).echo(create(ItemSchema, { value: "", sequence: 0 }), { timeoutMs: 1000 });
        assert.ok(seenTimeout !== null, "the router transport must forward the timeout header");
        assert.ok(Number(seenTimeout) <= 955, `wire timeout must be the remaining budget (<= 950 ms), got ${seenTimeout}`);
    });

    it("an explicit signal cancels a call parked inside the chain", async () => {
        const controller = new AbortController();
        const blocking: Interceptor = (next) => async (req) => {
            await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
            return next(req);
        };
        const server = createServer({ services: [], catalog, outgoingInterceptors: [blocking], remoteResolver: singleTransportResolver(opaqueTransport()) });
        const pending = inHandler(server, async (ctx) => (await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "", sequence: 0 }), { signal: controller.signal })).value);
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, (err: unknown) => err instanceof ConnectError && err.code === Code.Canceled);
    });

    it("the chain sees the handler's live ContextValues and the explicit headers of the call", async () => {
        let seenValues: unknown;
        let seenHeader: string | null = null;
        const observe: Interceptor = (next) => (req) => {
            seenValues = req.contextValues;
            seenHeader = req.header.get("x-explicit");
            return next(req);
        };
        let handlerValues: unknown;
        const server = createServer({ services: [], catalog, outgoingInterceptors: [observe], remoteResolver: singleTransportResolver(opaqueTransport()) });
        await inHandler(server, async (ctx) => {
            handlerValues = ctx.values;
            return (await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "", sequence: 0 }), { headers: { "x-explicit": "1" } })).value;
        });
        assert.strictEqual(seenValues, handlerValues, "the same ContextValues object must reach the chain");
        assert.strictEqual(seenHeader, "1");
    });

    it("cancelling a server stream mid-way: the chain observes exactly what it observes on a native Connect transport", async () => {
        // Oracle: the same interceptor mounted directly on a Connect transport
        // (`createGrpcTransport({ interceptors })`) against the same server.
        // Abort after the second message and keep iterating: the next pull must
        // reject with Canceled.
        async function consumeUntilSecond(items: AsyncIterable<Item>, controller: AbortController): Promise<void> {
            let n = 0;
            for await (const _item of items) {
                if (++n === 2) controller.abort();
            }
        }
        async function cancelMidway(run: (spy: Spy, controller: AbortController) => Promise<void>): Promise<{ calls: number; completed: number }> {
            const spy = makeSpy();
            const controller = new AbortController();
            await assert.rejects(run(spy, controller), (err: unknown) => err instanceof ConnectError && err.code === Code.Canceled);
            // Give a wrapper woken by the abort the chance to settle.
            await sleep(20);
            return { calls: spy.calls, completed: spy.completed };
        }
        const baseUrl = `http://127.0.0.1:${tcpServer.address?.port}`;
        const native = await cancelMidway(async (spy, controller) => {
            const client = createClient(StreamingService, createGrpcTransport({ baseUrl, interceptors: [spy.interceptor] }));
            await consumeUntilSecond(client.server(create(ItemSchema, { value: "s", sequence: 1000 }), { signal: controller.signal }), controller);
        });
        const viaChain = await cancelMidway(async (spy, controller) => {
            const server = createServer({ services: [], catalog, outgoingInterceptors: [spy.interceptor], remoteResolver: singleTransportResolver(tcpTransport) });
            await inHandler(server, async (ctx) => {
                await consumeUntilSecond(ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 1000 }), { signal: controller.signal }), controller);
                return "unreachable";
            });
        });
        // Connect's response wrapper short-circuits on abort without resuming a
        // generator parked at `yield`, so a response wrapper does not reach its
        // `finally` on a native transport either: the decorator must match that,
        // not improve on it silently.
        assert.strictEqual(native.calls, 1);
        assert.strictEqual(native.completed, 0, "native Connect transport: a wrapper parked at yield is not resumed on abort");
        assert.deepStrictEqual(viaChain, native, "chain over a resolver route must match the native transport");
    });
});

describe("createCatalogClient({ outgoingInterceptors })", () => {
    const standaloneKinds: Record<string, (client: ReturnType<typeof createCatalogClient>) => Promise<string>> = {
        unary: async (client) => (await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "u", sequence: 0 }))).value,
        server: async (client) => {
            const out: string[] = [];
            for await (const item of client.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 2 }))) out.push(item.value);
            return out.join(",");
        },
        client: async (client) => {
            const handle = client.stream("streaming.v1.StreamingService/Client")();
            handle.send(create(ItemSchema, { value: "c", sequence: 0 }));
            handle.send(create(ItemSchema, { value: "c", sequence: 1 }));
            return String((await handle.close()).total);
        },
        bidi: async (client) => {
            const handle = client.stream("streaming.v1.StreamingService/Bidi")();
            handle.send(create(ItemSchema, { value: "b", sequence: 0 }));
            handle.close();
            const out: string[] = [];
            for await (const item of handle.responses) out.push(item.value);
            return out.join(",");
        },
    };

    for (const [kind, run] of Object.entries(standaloneKinds)) {
        it(`${kind}: the explicit chain runs once and reaches the receiver over TCP`, async () => {
            const spy = makeSpy();
            const client = createCatalogClient({ catalog, resolver: mapResolver({ [StreamingService.typeName]: tcpTransport }), outgoingInterceptors: [spy.interceptor] });
            assert.strictEqual(await run(client), expected[kind]);
            assert.strictEqual(spy.calls, 1);
            assert.strictEqual(spy.completed, kind === "unary" ? 0 : 1);
        });
    }

    it("default: no chain, the resolver's transport is used as is", async () => {
        const client = createCatalogClient({ catalog, resolver: mapResolver({ [StreamingService.typeName]: tcpTransport }) });
        const res = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "u", sequence: 0 }));
        assert.strictEqual(res.value, "u|none");
    });
});

describe("outgoingInterceptors — cancellation of the remaining stream kinds, endpoints and shared ownership", () => {
    /** A router transport whose handlers are slow enough for a caller to abort mid-call. */
    function slowTransport(interceptors: Interceptor[] = []): Transport {
        return createRouterTransport(
            (router) =>
                router.service(StreamingService, {
                    echo: (req) => create(ItemSchema, { value: req.value, sequence: 0 }),
                    async *server() {},
                    client: async (requests) => {
                        for await (const _item of requests) {
                            // consume until the caller ends the request stream
                        }
                        await sleep(400);
                        return create(CountSchema, { total: 1 });
                    },
                    async *bidi(requests) {
                        for await (const item of requests) {
                            yield item;
                        }
                    },
                }),
            { transport: { interceptors } },
        );
    }

    async function expectCanceled(run: () => Promise<unknown>): Promise<void> {
        await assert.rejects(run(), (err: unknown) => err instanceof ConnectError && err.code === Code.Canceled);
        // Let a wrapper woken by the abort settle before the counters are read.
        await sleep(20);
    }

    it("aborting while a client-stream waits for its response: the chain matches a native Connect transport", async () => {
        const nativeSpy = makeSpy();
        const nativeController = new AbortController();
        const nativeClient = createClient(StreamingService, slowTransport([nativeSpy.interceptor]));
        setTimeout(() => nativeController.abort(), 60);
        await expectCanceled(() => nativeClient.client((async function* () { yield create(ItemSchema, { value: "c", sequence: 0 }); })(), { signal: nativeController.signal }));

        const chainSpy = makeSpy();
        const chainController = new AbortController();
        const server = createServer({ services: [], catalog, outgoingInterceptors: [chainSpy.interceptor], remoteResolver: singleTransportResolver(slowTransport()) });
        setTimeout(() => chainController.abort(), 60);
        await expectCanceled(() =>
            inHandler(server, async (ctx) => {
                const handle = ctx.stream("streaming.v1.StreamingService/Client")({ signal: chainController.signal });
                handle.send(create(ItemSchema, { value: "c", sequence: 0 }));
                return String((await handle.close()).total);
            }),
        );
        assert.strictEqual(nativeSpy.calls, 1);
        assert.deepStrictEqual({ calls: chainSpy.calls, completed: chainSpy.completed }, { calls: nativeSpy.calls, completed: nativeSpy.completed });
    });

    it("aborting a bidi stream after its first message: the chain matches a native Connect transport", async () => {
        const nativeSpy = makeSpy();
        const nativeController = new AbortController();
        const nativeClient = createClient(StreamingService, slowTransport([nativeSpy.interceptor]));
        await expectCanceled(async () => {
            const input = (async function* () {
                yield create(ItemSchema, { value: "b", sequence: 0 });
                await new Promise<void>((resolve) => nativeController.signal.addEventListener("abort", () => resolve(), { once: true }));
            })();
            for await (const _item of nativeClient.bidi(input, { signal: nativeController.signal })) nativeController.abort();
        });

        const chainSpy = makeSpy();
        const chainController = new AbortController();
        const server = createServer({ services: [], catalog, outgoingInterceptors: [chainSpy.interceptor], remoteResolver: singleTransportResolver(slowTransport()) });
        await expectCanceled(() =>
            inHandler(server, async (ctx) => {
                const handle = ctx.stream("streaming.v1.StreamingService/Bidi")({ signal: chainController.signal });
                handle.send(create(ItemSchema, { value: "b", sequence: 0 }));
                for await (const _item of handle.responses) chainController.abort();
                return "unreachable";
            }),
        );
        assert.strictEqual(nativeSpy.calls, 1);
        assert.deepStrictEqual({ calls: chainSpy.calls, completed: chainSpy.completed }, { calls: nativeSpy.calls, completed: nativeSpy.completed });
    });

    it("server.client(Desc, { endpoint }) wraps one transport per endpoint and asks the resolver once per key", async () => {
        const spy = makeSpy();
        const asked: Array<string | undefined> = [];
        const server = createServer({
            services: [],
            catalog,
            outgoingInterceptors: [spy.interceptor],
            remoteResolver: (ctx) => {
                asked.push(ctx.endpoint);
                return opaqueTransport();
            },
        });
        const item = create(ItemSchema, { value: "e", sequence: 0 });
        await server.client(StreamingService, { endpoint: "a" }).echo(item);
        await server.client(StreamingService, { endpoint: "b" }).echo(item);
        await server.client(StreamingService, { endpoint: "a" }).echo(item);
        assert.deepStrictEqual(asked, ["a", "b"]);
        assert.strictEqual(spy.calls, 3, "every call runs the chain once, whichever endpoint it goes to");
    });

    it("the chain and the resolver transport's own interceptor each run exactly once per call, the chain outside", async () => {
        const chainSpy = makeSpy();
        const transportSpy = makeSpy();
        const owned = createRouterTransport((router) => router.service(StreamingService, targetImpl), { transport: { interceptors: [transportSpy.interceptor] } });
        const server = createServer({ services: [], catalog, outgoingInterceptors: [chainSpy.interceptor], remoteResolver: singleTransportResolver(owned) });
        const client = server.client(StreamingService);
        await client.echo(create(ItemSchema, { value: "u", sequence: 0 }));
        for await (const _item of client.server(create(ItemSchema, { value: "s", sequence: 2 }))) {
            // drain
        }
        assert.deepStrictEqual({ chain: chainSpy.calls, transport: transportSpy.calls }, { chain: 2, transport: 2 });
        assert.ok(chainSpy.urls.every((url) => url.startsWith("https://catalog/")), "the chain sees the synthetic catalog URL");
        assert.ok(transportSpy.urls.every((url) => !url.startsWith("https://catalog/")), "the transport's own interceptor sees the request URL of the transport itself");
    });
});
