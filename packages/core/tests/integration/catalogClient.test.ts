/**
 * createCatalogClient — the catalog-typed call/stream surface usable OUTSIDE a
 * Server (issue #170: workers / schedulers / CLIs).
 *
 * Drives REAL in-memory dispatch: a `createRouterTransport` stub stands in for
 * the remote service, wired through the same `RemoteResolver` factories
 * (`singleTransportResolver`/`mapResolver`) that the in-handler `ctx.call`
 * uses. Asserts that a typed unary `call` reaches the resolved transport and
 * returns its response, that the transport is cached per route, that the typed
 * `stream` surface performs a real server-streaming dispatch (not a dead knob),
 * and that the operational error model mirrors `ctx.call`
 * (Unavailable / Internal / Unimplemented).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { createCatalogClient } from "../../src/catalogClient.ts";
import { mapResolver, singleTransportResolver } from "../../src/remoteResolver.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, type EchoResponse, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Count, CountSchema, type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

// Hand-written catalog augmentation (the same shape the buf plugin emits): one
// ConnectumCallMap entry per unary RPC, one ConnectumStreamMap entry per
// streaming RPC. Includes deliberately-bogus keys to exercise the guards.
// Keys must not collide with other test files' `declare module` augmentations:
// `tsc` merges every `ConnectumCallMap`/`ConnectumStreamMap` augmentation in the
// program into one interface, so a duplicate key with a different shape is a
// hard error. `streaming.v1.StreamingService/Echo` and `echo.v1.EchoService/Echo`
// share `ctxCall.test.ts`'s shapes (consistent → fine); the deliberately-bogus
// guard keys below are namespaced uniquely to this suite.
declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
        "phantom.v1.PhantomService/Vanish": { request: Item; response: Item };
        "streaming.v1.StreamingService/Absent": { request: Item; response: Item };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: Item; response: Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: Item; response: Item; kind: "bidi" };
    }
}

/** A router-transport serving StreamingService (unary + all streaming kinds), tagged with `marker`. */
function makeStreamingRemote(marker: string): Transport {
    return createRouterTransport((router) => {
        router.service(StreamingService, {
            echo: (req) => create(ItemSchema, { value: `${marker}:${req.value}`, sequence: req.sequence }),
            async *server(req) {
                for (let i = 0; i < 3; i++) {
                    yield create(ItemSchema, { value: `${marker}:${req.value}:${i}`, sequence: i });
                }
            },
            client: async (reqs) => {
                let total = 0;
                for await (const _ of reqs) total++;
                return create(CountSchema, { total });
            },
            async *bidi(reqs) {
                for await (const req of reqs) {
                    yield create(ItemSchema, { value: `${marker}:${req.value}`, sequence: req.sequence });
                }
            },
        });
    });
}

const catalog = defineCatalog({
    [StreamingService.typeName]: StreamingService,
    [EchoService.typeName]: EchoService,
});

describe("createCatalogClient — unary call (no Server)", () => {
    it("dispatches a typed unary call over the resolver-supplied transport and returns the response", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: singleTransportResolver(makeStreamingRemote("remote")),
        });

        const res = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "hi", sequence: 7 }));
        assert.strictEqual(res.value, "remote:hi", "must reach the resolved transport's handler");
        assert.strictEqual(res.sequence, 7, "response must round-trip through the real transport");
    });

    it("is fully typed off the catalog (compile-time surface)", async () => {
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(makeStreamingRemote("t")) });

        // The response is inferred as the catalog's response type (Item), not
        // `unknown`: accessing `.value`/`.sequence` only compiles because of it.
        const res: Item = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }));
        assert.strictEqual(typeof res.value, "string");

        // @ts-expect-error — wrong request message type for this key
        client.call("streaming.v1.StreamingService/Echo", create(CountSchema, { total: 1 })).catch(() => {});

        // @ts-expect-error — key absent from ConnectumCallMap
        client.call("not.a.Real/Method", create(ItemSchema, { value: "x", sequence: 0 })).catch(() => {});
    });

    it("routes per typeName via mapResolver — only the mapped service resolves", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: mapResolver({ [StreamingService.typeName]: makeStreamingRemote("mapped") }),
        });
        const res = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }));
        assert.strictEqual(res.value, "mapped:x");
    });

    it("caches the resolved transport per (typeName, endpoint) — resolver runs at most once", async () => {
        let resolverCalls = 0;
        const remote = makeStreamingRemote("C");
        const client = createCatalogClient({
            catalog,
            resolver: ({ typeName }) => {
                resolverCalls += typeName === StreamingService.typeName ? 1 : 0;
                return remote;
            },
        });

        const a = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "1", sequence: 0 }));
        const b = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "2", sequence: 0 }));
        assert.strictEqual(a.value, "C:1");
        assert.strictEqual(b.value, "C:2");
        assert.strictEqual(resolverCalls, 1, "transport must be cached after the first call");
    });

    it("forwards CallOptions.headers verbatim (no inbound request to propagate from)", async () => {
        const HEADER = "x-trace-test";
        const headerRemote = createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (_req, ctx) => create(ItemSchema, { value: ctx.requestHeader.get(HEADER) ?? "none", sequence: 0 }),
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            });
        });
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(headerRemote) });
        const res = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }), { headers: { [HEADER]: "abc" } });
        assert.strictEqual(res.value, "abc", "explicit header must reach the transport");
    });
});

describe("createCatalogClient — streaming (server-streaming) is a real dispatch", () => {
    it("opens a typed server-stream over the resolved transport and yields every message", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: singleTransportResolver(makeStreamingRemote("S")),
        });

        const open = client.stream("streaming.v1.StreamingService/Server");
        const received: string[] = [];
        for await (const item of open(create(ItemSchema, { value: "go", sequence: 0 }))) {
            received.push(item.value);
        }
        assert.deepStrictEqual(received, ["S:go:0", "S:go:1", "S:go:2"], "must yield the remote's full stream");
    });

    it("opens a typed client-stream: push N requests, close() resolves the aggregate", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: singleTransportResolver(makeStreamingRemote("CS")),
        });
        const handle = client.stream("streaming.v1.StreamingService/Client")();
        handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
        handle.send(create(ItemSchema, { value: "b", sequence: 1 }));
        const res = await handle.close();
        assert.strictEqual(res.total, 2, "client-streaming must aggregate both pushed requests");
    });

    it("opens a typed bidi-stream: push requests while iterating echoed responses", async () => {
        const client = createCatalogClient({
            catalog,
            resolver: singleTransportResolver(makeStreamingRemote("BS")),
        });
        const handle = client.stream("streaming.v1.StreamingService/Bidi")();
        handle.send(create(ItemSchema, { value: "one", sequence: 0 }));
        handle.send(create(ItemSchema, { value: "two", sequence: 1 }));
        handle.close();
        const received: string[] = [];
        for await (const item of handle.responses) {
            received.push(item.value);
        }
        assert.deepStrictEqual(received, ["BS:one", "BS:two"], "bidi must echo every pushed request back");
    });

    it("resolves the transport LAZILY: factory invocation does not throw on resolver-null; iteration does", async () => {
        // Parity with ctx.stream's documented timing: a resolver/transport
        // failure must surface on iteration/close(), never on factory call.
        let resolverCalls = 0;
        const client = createCatalogClient({
            catalog,
            resolver: () => {
                resolverCalls++;
                return null;
            },
        });

        // server-streaming: invoking the factory must NOT throw or resolve.
        const open = client.stream("streaming.v1.StreamingService/Server");
        const stream = open(create(ItemSchema, { value: "x", sequence: 0 }));
        assert.strictEqual(resolverCalls, 0, "resolver must not run until the stream is iterated");
        await assert.rejects(
            (async () => {
                for await (const _ of stream) {
                    // unreachable — resolution fails on first .next()
                }
            })(),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable,
        );
        assert.strictEqual(resolverCalls, 1, "resolution must happen on iteration");

        // client-streaming: failure surfaces on await close(), not on factory call.
        const handle = client.stream("streaming.v1.StreamingService/Client")();
        handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
        await assert.rejects(() => handle.close(), (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable);
    });
});

describe("createCatalogClient — operational error model (mirrors ctx.call)", () => {
    it("unresolved service (resolver returns null) → Code.Unavailable", async () => {
        const client = createCatalogClient({ catalog, resolver: () => null });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 })),
            (err: unknown) => {
                assert.ok(err instanceof ConnectError, `expected ConnectError, got ${String(err)}`);
                assert.strictEqual(err.code, Code.Unavailable);
                return true;
            },
        );
    });

    it("resolver throws → Code.Internal (cause preserved)", async () => {
        const boom = new Error("resolver exploded");
        const client = createCatalogClient({
            catalog,
            resolver: () => {
                throw boom;
            },
        });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 })),
            (err: unknown) => {
                assert.ok(err instanceof ConnectError, `expected ConnectError, got ${String(err)}`);
                assert.strictEqual(err.code, Code.Internal);
                assert.strictEqual(err.cause, boom, "original cause must be preserved");
                return true;
            },
        );
    });

    it("unknown service in the catalog → Code.Unimplemented", async () => {
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(makeStreamingRemote("U")) });
        await assert.rejects(
            () => client.call("phantom.v1.PhantomService/Vanish", create(ItemSchema, { value: "x", sequence: 0 })),
            (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Unimplemented);
                return true;
            },
        );
    });

    it("known service, unknown method → Code.Unimplemented", async () => {
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(makeStreamingRemote("U")) });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Absent", create(ItemSchema, { value: "x", sequence: 0 })),
            (err: unknown) => {
                assert.ok(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Unimplemented);
                return true;
            },
        );
    });

    it("calling a streaming method via .call → Code.Unimplemented (use .stream)", async () => {
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(makeStreamingRemote("U")) });
        await assert.rejects(
            // @ts-expect-error — "Server" is a streaming key, not a ConnectumCallMap key
            () => client.call("streaming.v1.StreamingService/Server", create(ItemSchema, { value: "x", sequence: 0 })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unimplemented,
        );
    });
});
