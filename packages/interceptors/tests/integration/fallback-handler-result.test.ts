/**
 * What a fallback handler may return, as callers see it over real transports.
 *
 * The documented example returns a plain object. Oracle: the response of a failed call
 * must be a message of the method's output type; a handler that returns something else
 * must fail with an error that names the handler on the server, and the client must get the
 * generic `internal error` text, never a serialization text from the protocol layer.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";

describe("fallback handler result over real transports", () => {
    let server: Server;
    let clients: Record<string, Client<typeof EchoService>>;
    let handlerResult: () => unknown = () => ({ message: "unset" });
    const reported: Error[] = [];

    before(async () => {
        server = createServer({
            services: [
                defineService(EchoService, {
                    echo: () => {
                        throw new ConnectError("dependency down", Code.Unavailable);
                    },
                    secureEcho: () => {
                        throw new ConnectError("dependency down", Code.Unavailable);
                    },
                    rateLimitedEcho: () => {
                        throw new ConnectError("dependency down", Code.Unavailable);
                    },
                }),
            ],
            interceptors: createDefaultInterceptors({
                errorHandler: { onError: (info) => void reported.push(info.error) },
                fallback: { handler: () => handlerResult() },
            }),
            port: 0,
            allowHTTP1: false,
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const baseUrl = `http://localhost:${port}`;
        clients = {
            grpc: createClient(EchoService, createGrpcTransport({ baseUrl })),
            connect: createClient(EchoService, createConnectTransport({ baseUrl, httpVersion: "2" })),
            grpcWeb: createClient(EchoService, createGrpcWebTransport({ baseUrl, httpVersion: "2" })),
            local: server.localClient(EchoService),
        };
    });

    after(async () => {
        await server.stop();
    });

    for (const transport of ["grpc", "connect", "grpcWeb", "local"]) {
        it(`${transport}: a plain object returned by the handler is served as the response`, async () => {
            handlerResult = () => ({ message: "from the plain object" });

            const res = await clients[transport]!.echo(create(EchoRequestSchema, { message: "x" }));

            assert.strictEqual(res.message, "from the plain object");
        });

        for (const [label, produce] of [
            ["undefined", () => undefined],
            ["an object with an unknown field", () => ({ items: [] })],
        ] as const) {
            it(`${transport}: ${label} fails with internal error and names the handler on the server`, async () => {
                handlerResult = produce;
                reported.length = 0;

                const err = await clients[transport]!.echo(create(EchoRequestSchema, { message: "x" })).then(
                    () => assert.fail("the call should have failed"),
                    (e: unknown) => ConnectError.from(e),
                );

                assert.strictEqual(err.code, Code.Internal);
                assert.strictEqual(err.rawMessage, "internal error", "no serialization text may reach the client");
                assert.strictEqual(reported.length, 1, "the server side must see the failure");
                assert.match(reported[0]!.cause instanceof Error ? reported[0]!.cause.message : reported[0]!.message, /createFallbackInterceptor: handler must return a /);
            });
        }
    }
});
