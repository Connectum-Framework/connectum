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
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/RateLimitedEcho": { request: import("../fixtures/echo/v1/echo_pb.ts").EchoRequest; response: import("../fixtures/echo/v1/echo_pb.ts").EchoResponse };
    }
}

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
