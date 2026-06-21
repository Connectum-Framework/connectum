/**
 * ctx.stream — declarative streaming catalog calls from inside a handler.
 *
 * Covers section 5: server-streaming (AsyncIterable), client-streaming
 * (send/close → response), bidi-streaming (send/close/responses), consumer
 * early-break, and the default mid-stream-failure behaviour (deliver received
 * messages, then throw the terminal error).
 *
 * StreamingService is mounted locally and reached via ctx.stream; EchoService
 * is the unary caller that drives the stream and returns an encoded summary.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Context } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Item; kind: "bidi" };
    }
}

type SecureImpl = (req: EchoRequest, ctx: Context) => Promise<EchoResponse>;

/** StreamingService mounted locally as the ctx.stream target. */
function streamingTarget() {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server(req) {
            for (let i = 0; i < req.sequence; i++) {
                yield create(ItemSchema, { value: `${req.value}-${i}`, sequence: i });
            }
        },
        async client(requests) {
            let total = 0;
            for await (const _item of requests) total += 1;
            return create(CountSchema, { total });
        },
        async *bidi(requests) {
            for await (const item of requests) {
                yield create(ItemSchema, { value: `echo-${item.value}`, sequence: item.sequence });
            }
        },
    });
}

/** EchoService whose `secureEcho` drives a ctx.stream call and returns a summary. */
function makeCaller(secureEcho: SecureImpl) {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        secureEcho,
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

function makeServer(secure: SecureImpl, target = streamingTarget()) {
    return createServer({
        services: [target, makeCaller(secure)],
        catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
    });
}

describe("ctx.stream — server-streaming", () => {
    it("yields every response message in order", async () => {
        const server = makeServer(async (req, ctx) => {
            const out: string[] = [];
            for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: req.message, sequence: 3 }))) {
                out.push(item.value);
            }
            return create(EchoResponseSchema, { message: out.join(","), timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "hi" }));
        assert.strictEqual(res.message, "hi-0,hi-1,hi-2");
    });

    it("supports consumer early-break without hanging", async () => {
        const server = makeServer(async (req, ctx) => {
            const out: string[] = [];
            for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: req.message, sequence: 100 }))) {
                out.push(item.value);
                if (out.length === 2) break;
            }
            return create(EchoResponseSchema, { message: out.join(","), timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "z" }));
        assert.strictEqual(res.message, "z-0,z-1");
    });

    it("delivers received messages, then throws on a mid-stream error", async () => {
        const failingTarget = defineService(StreamingService, {
            echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
            async *server(req) {
                yield create(ItemSchema, { value: `${req.value}-0`, sequence: 0 });
                yield create(ItemSchema, { value: `${req.value}-1`, sequence: 1 });
                throw new ConnectError("boom mid-stream", Code.DataLoss);
            },
            async client() {
                return create(CountSchema, { total: 0 });
            },
            async *bidi() {},
        });

        const received: string[] = [];
        let captured: unknown;
        const server = makeServer(async (req, ctx) => {
            try {
                for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: req.message, sequence: 0 }))) {
                    received.push(item.value);
                }
            } catch (err) {
                captured = err;
            }
            return create(EchoResponseSchema, { message: received.join(","), timestamp: 0n });
        }, failingTarget);

        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "m" }));
        assert.strictEqual(res.message, "m-0,m-1", "messages before the error are delivered");
        assert.ok(captured instanceof ConnectError, `terminal error must surface after delivery, got: ${String(captured)}`);
    });
});

describe("ctx.stream — client-streaming", () => {
    it("sends N requests, close() resolves the aggregated response", async () => {
        const server = makeServer(async (req, ctx) => {
            const handle = ctx.stream("streaming.v1.StreamingService/Client")();
            handle.send(create(ItemSchema, { value: req.message, sequence: 0 }));
            handle.send(create(ItemSchema, { value: req.message, sequence: 1 }));
            handle.send(create(ItemSchema, { value: req.message, sequence: 2 }));
            const count = await handle.close();
            return create(EchoResponseSchema, { message: String(count.total), timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(res.message, "3");
    });
});

describe("ctx.stream — bidi-streaming", () => {
    it("echoes each sent request on the responses stream", async () => {
        const server = makeServer(async (_req, ctx) => {
            const handle = ctx.stream("streaming.v1.StreamingService/Bidi")();
            handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
            handle.send(create(ItemSchema, { value: "b", sequence: 1 }));
            handle.close();
            const out: string[] = [];
            for await (const item of handle.responses) out.push(item.value);
            return create(EchoResponseSchema, { message: out.join(","), timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(res.message, "echo-a,echo-b");
    });
});

describe("ctx.stream — validation", () => {
    it("throws Unimplemented when used on a unary method", async () => {
        let captured: unknown;
        const server = makeServer(async (_req, ctx) => {
            try {
                (ctx.stream as (method: string) => unknown)("streaming.v1.StreamingService/Echo");
            } catch (err) {
                captured = err;
            }
            return create(EchoResponseSchema, { message: "ok", timestamp: 0n });
        });
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.ok(captured instanceof ConnectError && captured.code === Code.Unimplemented, `expected Unimplemented, got: ${String(captured)}`);
    });

    it("resolves a remote stream target LAZILY — the resolver runs on iteration, not on factory invocation", async () => {
        // Regression lock: ctx.stream's transport resolution must stay lazy
        // (documented on _makeStreamHandle). The stream target is NOT mounted
        // locally, so it goes through the resolver; the factory call must not
        // trigger it — only iterating the returned AsyncIterable must.
        let resolverCalls = 0;
        let observedCallsAtFactoryTime = -1;
        let captured: unknown;
        const server = createServer({
            services: [
                makeCaller(async (_req, ctx) => {
                    const stream = ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "x", sequence: 0 }));
                    observedCallsAtFactoryTime = resolverCalls; // must still be 0
                    try {
                        for await (const _ of stream) {
                            // unreachable: resolver returns null → Unavailable on first .next()
                        }
                    } catch (err) {
                        captured = err;
                    }
                    return create(EchoResponseSchema, { message: "done", timestamp: 0n });
                }),
            ],
            // Only EchoService is local; StreamingService is reached remotely.
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: ({ typeName }) => {
                resolverCalls += typeName === StreamingService.typeName ? 1 : 0;
                return null;
            },
        });

        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(observedCallsAtFactoryTime, 0, "resolver must NOT run when the stream factory is invoked");
        assert.strictEqual(resolverCalls, 1, "resolver must run exactly once, on iteration");
        assert.ok(captured instanceof ConnectError && captured.code === Code.Unavailable, `expected Unavailable on iteration, got: ${String(captured)}`);
    });
});

describe("ctx.stream — open items (escalated, not yet locked)", () => {
    // Q3 / task 5.6: default is deliver-then-error (covered above). An opt-in
    // `failFast` mode (discard partial, throw immediately) is pending a precise
    // semantics confirmation for pull-based streams.
    it.todo("failFast mode (discard partial results) — pending semantics confirmation");
});
