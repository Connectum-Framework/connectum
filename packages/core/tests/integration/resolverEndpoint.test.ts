/**
 * An empty `endpoint` is an absent endpoint.
 *
 * The transport cache shares one entry between "no endpoint" and `""`, so the
 * resolver, which runs once per entry, must see the same context for both.
 * Otherwise the context it received (and the transport that every later call
 * reused) depended on which call came first.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { createCatalogClient } from "../../src/catalogClient.ts";
import { defineService } from "../../src/defineService.ts";
import type { ResolverContext } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
    }
}

const catalog = defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService });
const ITEM = () => create(ItemSchema, { value: "x", sequence: 0 });

const remote = createRouterTransport((router) => {
    router.service(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server() {},
        client: async () => {
            throw new Error("unused");
        },
        async *bidi() {},
    });
});

const orders: Array<Array<string | undefined>> = [
    [undefined, ""],
    ["", undefined],
];

describe("createCatalogClient: empty endpoint", () => {
    for (const endpoints of orders) {
        it(`hands the resolver one context without an endpoint for ${JSON.stringify(endpoints.map(String))}`, async () => {
            const seen: ResolverContext[] = [];
            const client = createCatalogClient({
                catalog,
                resolver: (ctx) => {
                    seen.push(ctx);
                    return remote;
                },
            });
            for (const endpoint of endpoints) {
                await client.call("streaming.v1.StreamingService/Echo", ITEM(), endpoint === undefined ? undefined : { endpoint });
            }
            assert.strictEqual(seen.length, 1, "one route, one resolution");
            assert.deepStrictEqual(seen[0], { typeName: StreamingService.typeName });
            assert.ok(!("endpoint" in (seen[0] as object)), "an empty endpoint must not reach the resolver");
        });
    }

    it("keeps a non-empty endpoint in the context", async () => {
        const seen: ResolverContext[] = [];
        const client = createCatalogClient({
            catalog,
            resolver: (ctx) => {
                seen.push(ctx);
                return remote;
            },
        });
        await client.call("streaming.v1.StreamingService/Echo", ITEM(), { endpoint: "eu" });
        assert.deepStrictEqual(seen, [{ typeName: StreamingService.typeName, endpoint: "eu" }]);
    });

    it("does not print an empty endpoint in the no-route message", async () => {
        const client = createCatalogClient({ catalog, resolver: () => null });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Echo", ITEM(), { endpoint: "" }),
            (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.strictEqual(error.code, Code.Unavailable);
                assert.doesNotMatch(error.rawMessage, /endpoint/);
                return true;
            },
        );
    });
});

describe("ctx.call and server.client(): empty endpoint", () => {
    for (const endpoints of orders) {
        it(`ctx.call hands the resolver one context without an endpoint for ${JSON.stringify(endpoints.map(String))}`, async () => {
            const seen: ResolverContext[] = [];
            const server = createServer({
                catalog,
                enabledServices: [EchoService.typeName],
                remoteResolver: (ctx) => {
                    seen.push(ctx);
                    return remote;
                },
                services: [
                    defineService(EchoService, {
                        echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                        secureEcho: async (_req, ctx) => {
                            for (const endpoint of endpoints) {
                                await ctx.call("streaming.v1.StreamingService/Echo", ITEM(), endpoint === undefined ? undefined : { endpoint });
                            }
                            return create(EchoResponseSchema, { message: "", timestamp: 0n });
                        },
                        rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                    }),
                ],
            });
            await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
            assert.strictEqual(seen.length, 1);
            assert.deepStrictEqual(seen[0], { typeName: StreamingService.typeName });
            assert.ok(!("endpoint" in (seen[0] as object)));
        });

        it(`server.client shares the route with ctx.call-style keys for ${JSON.stringify(endpoints.map(String))}`, () => {
            const seen: ResolverContext[] = [];
            const server = createServer({
                catalog,
                enabledServices: [],
                services: [],
                remoteResolver: (ctx) => {
                    seen.push(ctx);
                    return remote;
                },
            });
            for (const endpoint of endpoints) {
                server.client(StreamingService, endpoint === undefined ? undefined : { endpoint });
            }
            assert.deepStrictEqual(seen, [{ typeName: StreamingService.typeName }]);
        });
    }

    it("server.client does not print an empty endpoint in the no-route message", () => {
        const server = createServer({ catalog, enabledServices: [], services: [], remoteResolver: () => null });
        assert.throws(
            () => server.client(StreamingService, { endpoint: "" }),
            (error: unknown) => error instanceof ConnectError && error.code === Code.Unavailable && !/endpoint/.test(error.rawMessage),
        );
    });
});
