/**
 * `ctx.call` / `ctx.stream` to a catalog service that is not mounted, on a
 * server with no `remoteResolver`.
 *
 * That is a wiring mistake, not an outage. It used to surface as
 * `Unavailable` ("the resolver returned null") although there is no resolver,
 * and `Unavailable` is the code the `retry` interceptor retries by default, so
 * the mistake was retried as if the service were temporarily down. It is now
 * `FailedPrecondition`, with the diagnosis `server.client()` already gives.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
    }
}

const catalog = defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService });
const base = { port: 0, host: "127.0.0.1", allowHTTP1: false } as const;

/** Caller mounted alone: `StreamingService` is in the catalog but nothing can reach it. */
function makeServer(kind: "call" | "stream", captured: unknown[]) {
    return createServer({
        ...base,
        catalog,
        enabledServices: [EchoService.typeName],
        services: [
            defineService(EchoService, {
                echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                secureEcho: async (_req, ctx) => {
                    try {
                        if (kind === "call") {
                            await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }));
                        } else {
                            for await (const _item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "x", sequence: 0 }))) {
                                // nothing may arrive
                            }
                        }
                    } catch (error) {
                        captured.push(error);
                        throw error;
                    }
                    return create(EchoResponseSchema, { message: "", timestamp: 0n });
                },
                rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
            }),
        ],
    });
}

function assertConfigurationError(error: unknown): void {
    assert.ok(error instanceof ConnectError, `expected a ConnectError, got ${String(error)}`);
    assert.strictEqual(error.code, Code.FailedPrecondition, "a missing resolver is a configuration error, which a retry cannot fix");
    assert.ok(error.rawMessage.includes(StreamingService.typeName), `must name the service: ${error.rawMessage}`);
    assert.match(error.rawMessage, /not mounted locally and no remoteResolver is configured/);
    assert.match(error.rawMessage, /createServer\(\{ remoteResolver \}\)/);
}

describe("catalog call without a remoteResolver", () => {
    for (const kind of ["call", "stream"] as const) {
        it(`ctx.${kind} fails with FailedPrecondition and the server.client() diagnosis`, async () => {
            const captured: unknown[] = [];
            const server = makeServer(kind, captured);
            await server
                .localClient(EchoService)
                .secureEcho(create(EchoRequestSchema, { message: "go" }))
                .catch(() => {});
            assert.strictEqual(captured.length, 1);
            assertConfigurationError(captured[0]);
        });
    }

    it("reaches an HTTP/2 client as FailedPrecondition, not Unavailable", async () => {
        const server = makeServer("call", []);
        await server.start();
        try {
            const address = server.address;
            assert.ok(address !== null);
            const client = createClient(EchoService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${address.port}` }));
            const error = await client.secureEcho(create(EchoRequestSchema, { message: "go" })).catch((e: unknown) => e);
            assert.ok(error instanceof ConnectError);
            assert.strictEqual(error.code, Code.FailedPrecondition);
        } finally {
            await server.stop();
        }
    });

    it("keeps Unavailable for a configured resolver that returns null", async () => {
        const captured: unknown[] = [];
        const server = createServer({
            ...base,
            catalog,
            enabledServices: [EchoService.typeName],
            remoteResolver: () => null,
            services: [
                defineService(EchoService, {
                    echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                    secureEcho: async (_req, ctx) => {
                        try {
                            await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }));
                        } catch (error) {
                            captured.push(error);
                        }
                        return create(EchoResponseSchema, { message: "", timestamp: 0n });
                    },
                    rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                }),
            ],
        });
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
        assert.ok(captured[0] instanceof ConnectError && captured[0].code === Code.Unavailable);
    });

    it("still reaches a locally mounted service without a resolver", async () => {
        const server = createServer({
            ...base,
            catalog,
            services: [
                defineService(EchoService, {
                    echo: () => create(EchoResponseSchema, { message: "local", timestamp: 0n }),
                    secureEcho: async (_req, ctx) => create(EchoResponseSchema, { message: (await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }))).message, timestamp: 0n }),
                    rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                }),
            ],
        });
        const response = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
        assert.strictEqual(response.message, "local");
    });
});
