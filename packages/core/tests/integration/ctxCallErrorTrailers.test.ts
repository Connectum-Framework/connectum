/**
 * Regression: an error surfaced from an in-process `ctx.call` must reach an
 * EXTERNAL gRPC client as a clean ConnectError — not an HTTP/2 protocol error.
 *
 * The in-process router transport tags responses with `content-length` /
 * `content-type`. When a `ctx.call` error carried those in its metadata, the
 * outer HTTP/2 server re-serialized them into gRPC error trailers, where
 * `content-length` is illegal → `NGHTTP2_PROTOCOL_ERROR` on the client.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Context } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/RateLimitedEcho": { request: import("../fixtures/echo/v1/echo_pb.ts").EchoRequest; response: import("../fixtures/echo/v1/echo_pb.ts").EchoResponse };
        "streaming.v1.StreamingService/Echo": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Item };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: import("../fixtures/streaming/v1/streaming_pb.ts").Item; response: import("../fixtures/streaming/v1/streaming_pb.ts").Item; kind: "bidi" };
    }
}

// The framing headers the in-process router transport tags onto responses are illegal in
// HTTP/2 trailers (RFC 9113, section 8.1: trailers carry no message framing fields such as
// content-length), so an error that crosses back into the caller's response must not
// carry them. The error is observed where the handler catches it, before any outer
// server re-serializes it: whether a given runtime turns a leaked header into a protocol
// error on the wire depends on its HTTP/2 implementation.
describe("errors propagated out of ctx.call and ctx.stream carry no message-framing metadata", () => {
    const FRAMING_HEADERS = ["content-length", "content-type", "content-encoding"];

    /** Metadata names present on the error that `ctx.call` / `ctx.stream` raised inside the handler. */
    async function leakedFramingHeaders(drive: (ctx: Context) => Promise<unknown>): Promise<{ code: Code | undefined; leaked: string[] }> {
        let caught: unknown;
        const failing = defineService(StreamingService, {
            echo: () => {
                throw new ConnectError("nope", Code.NotFound);
            },
            async *server() {
                throw new ConnectError("nope", Code.NotFound);
            },
            async client(requests) {
                for await (const _ of requests) {
                    // drain
                }
                throw new ConnectError("nope", Code.NotFound);
            },
            async *bidi(requests) {
                for await (const _ of requests) {
                    throw new ConnectError("nope", Code.NotFound);
                }
            },
        });
        const caller = defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            async secureEcho(_req, ctx) {
                try {
                    await drive(ctx);
                } catch (error) {
                    caught = error;
                }
                return create(EchoResponseSchema, { message: "done", timestamp: 0n });
            },
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const server = createServer({ services: [failing, caller], catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }) });
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        const error = ConnectError.from(caught);
        return { code: error.code, leaked: FRAMING_HEADERS.filter((name) => error.metadata.has(name)) };
    }

    const cases: Array<[string, (ctx: Context) => Promise<unknown>]> = [
        ["a unary ctx.call", (ctx) => ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }))],
        [
            "a server-streaming ctx.stream",
            async (ctx) => {
                for await (const _ of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "x", sequence: 0 }))) {
                    // the first read fails
                }
            },
        ],
        [
            "a client-streaming ctx.stream",
            async (ctx) => {
                const handle = ctx.stream("streaming.v1.StreamingService/Client")();
                handle.send(create(ItemSchema, { value: "x", sequence: 0 }));
                await handle.close();
            },
        ],
        [
            "a bidi-streaming ctx.stream",
            async (ctx) => {
                const handle = ctx.stream("streaming.v1.StreamingService/Bidi")();
                handle.send(create(ItemSchema, { value: "x", sequence: 0 }));
                handle.close();
                for await (const _ of handle.responses) {
                    // the first read fails
                }
            },
        ],
    ];

    for (const [name, drive] of cases) {
        it(`${name} raises the downstream code with no framing header in its metadata`, async () => {
            assert.deepEqual(await leakedFramingHeaders(drive), { code: Code.NotFound, leaked: [] });
        });
    }
});

describe("ctx.call error → external gRPC client trailers", () => {
    it("surfaces the downstream Code, not a protocol error, over HTTP/2", async () => {
        // EchoService is both caller and target: secureEcho fans out to
        // rateLimitedEcho (local), which throws ConnectError(NotFound).
        const echo = defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            async secureEcho(req, ctx) {
                return await ctx.call("echo.v1.EchoService/RateLimitedEcho", create(EchoRequestSchema, { message: req.message }));
            },
            rateLimitedEcho: () => {
                throw new ConnectError("nope", Code.NotFound);
            },
        });

        const server = createServer({
            services: [echo],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: false,
        });
        await server.start();
        after(async () => {
            if (server.state === "running") await server.stop();
        });

        const port = server.address?.port ?? 0;
        const client = createClient(EchoService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` }));

        await assert.rejects(
            client.secureEcho(create(EchoRequestSchema, { message: "x" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
            "external gRPC client must see Code.NotFound (not NGHTTP2_PROTOCOL_ERROR)",
        );
    });
});
