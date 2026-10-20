/**
 * `createLocalClient(server, service)` — a typed client that reaches the handlers
 * of a server in memory, without the server being started and without a socket.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createServer, defineService } from "@connectum/core";
import { createLocalClient } from "../../src/createLocalClient.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echoRoutes = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: `echo-service:${req.message}`, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

const streamingRoutes = defineService(StreamingService, {
    echo: (req) => create(ItemSchema, { value: `streaming-service:${req.value}`, sequence: req.sequence }),
    async *server() {},
    client: async () => ({ total: 0 }),
    async *bidi() {},
});

describe("createLocalClient", () => {
    it("calls the handler of a server that was never started", async () => {
        const server = createServer({ services: [echoRoutes] });
        const client = createLocalClient(server, EchoService);

        const res = await client.echo(create(EchoRequestSchema, { message: "ping" }));

        assert.strictEqual(res.message, "echo-service:ping");
        assert.ok(!server.address, "no socket may be bound for an in-process call");
    });

    it("returns a client of the service it was asked for when the server registers several", async () => {
        const server = createServer({ services: [echoRoutes, streamingRoutes] });

        const echo = await createLocalClient(server, EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        const item = await createLocalClient(server, StreamingService).echo(create(ItemSchema, { value: "b", sequence: 9 }));

        assert.strictEqual(echo.message, "echo-service:a");
        assert.strictEqual(item.value, "streaming-service:b");
        assert.strictEqual(item.sequence, 9);
    });

    it("rejects with Unimplemented for a service the server does not register", async () => {
        const server = createServer({ services: [echoRoutes] });

        await assert.rejects(createLocalClient(server, StreamingService).echo(create(ItemSchema, { value: "x", sequence: 0 })), (err: unknown) => ConnectError.from(err).code === Code.Unimplemented);
    });

    it("delivers a handler's ConnectError with its code and message", async () => {
        const failing = defineService(EchoService, {
            echo: () => {
                throw new ConnectError("no such record", Code.NotFound);
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const client = createLocalClient(createServer({ services: [failing] }), EchoService);

        await assert.rejects(client.echo(create(EchoRequestSchema, { message: "x" })), (err: unknown) => {
            const connectErr = ConnectError.from(err);
            assert.strictEqual(connectErr.code, Code.NotFound);
            assert.strictEqual(connectErr.rawMessage, "no such record");
            return true;
        });
    });
});
