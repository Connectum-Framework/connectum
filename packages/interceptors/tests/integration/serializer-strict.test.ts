/**
 * The serializer with strict unknown-field handling, over real transports.
 *
 * The option set the guide shows, `{ alwaysEmitImplicit: true, ignoreUnknownFields: false }`,
 * must not break valid calls: a real handler answers with protobuf messages, and strictness
 * is about unknown fields in input, not about the `$typeName` marker every message carries.
 * Unary, server-streaming, client-streaming and bidirectional calls are all covered, over
 * gRPC, Connect, gRPC-Web and `localClient()`.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { CountSchema, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";

describe("serializer with ignoreUnknownFields=false over real transports", () => {
    let server: Server;
    let clients: Record<string, Client<typeof StreamingService>>;
    const failures: string[] = [];

    before(async () => {
        server = createServer({
            services: [
                defineService(StreamingService, {
                    // The handlers answer with real messages, as generated code and `create()` produce them.
                    echo: (req) => create(ItemSchema, { value: `echo:${req.value}`, sequence: req.sequence }),
                    async *server(req) {
                        for (let i = 0; i < 3; i++) {
                            yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
                        }
                    },
                    async client(requests) {
                        let total = 0;
                        for await (const _item of requests) total++;
                        return create(CountSchema, { total });
                    },
                    async *bidi(requests) {
                        for await (const item of requests) {
                            yield create(ItemSchema, { value: `bidi:${item.value}`, sequence: item.sequence });
                        }
                    },
                }),
            ],
            interceptors: createDefaultInterceptors({
                errorHandler: { logErrors: false, onError: (info) => void failures.push(info.error.message) },
                serializer: { alwaysEmitImplicit: true, ignoreUnknownFields: false },
            }),
            port: 0,
            allowHTTP1: false,
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const baseUrl = `http://localhost:${port}`;
        clients = {
            grpc: createClient(StreamingService, createGrpcTransport({ baseUrl })),
            connect: createClient(StreamingService, createConnectTransport({ baseUrl, httpVersion: "2" })),
            grpcWeb: createClient(StreamingService, createGrpcWebTransport({ baseUrl, httpVersion: "2" })),
            local: server.localClient(StreamingService),
        };
    });

    after(async () => {
        await server.stop();
    });

    async function* items(...values: string[]) {
        for (const [index, value] of values.entries()) yield create(ItemSchema, { value, sequence: index });
    }

    for (const transport of ["grpc", "connect", "grpcWeb", "local"]) {
        it(`${transport}: unary call succeeds`, async () => {
            failures.length = 0;
            const res = await clients[transport]!.echo(create(ItemSchema, { value: "hi", sequence: 4 }));
            assert.deepStrictEqual([res.value, res.sequence], ["echo:hi", 4]);
            assert.deepStrictEqual(failures, []);
        });

        it(`${transport}: server-streaming call succeeds`, async () => {
            failures.length = 0;
            const received: string[] = [];
            for await (const res of clients[transport]!.server(create(ItemSchema, { value: "s" }))) received.push(res.value);
            assert.deepStrictEqual(received, ["s:0", "s:1", "s:2"]);
            assert.deepStrictEqual(failures, []);
        });

        it(`${transport}: client-streaming call succeeds`, async () => {
            failures.length = 0;
            const res = await clients[transport]!.client(items("a", "b", "c"));
            assert.strictEqual(res.total, 3);
            assert.deepStrictEqual(failures, []);
        });

        it(`${transport}: bidirectional call succeeds`, async () => {
            failures.length = 0;
            const received: string[] = [];
            for await (const res of clients[transport]!.bidi(items("a", "b"))) received.push(res.value);
            assert.deepStrictEqual(received, ["bidi:a", "bidi:b"]);
            assert.deepStrictEqual(failures, []);
        });
    }
});
