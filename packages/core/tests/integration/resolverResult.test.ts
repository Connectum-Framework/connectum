/**
 * A `remoteResolver` result that is neither `null` nor a `Transport`.
 *
 * Declaring the resolver `async`, or mapping a name to the wrong kind of value,
 * used to be accepted: the value was cached and every call failed with
 * `transport.unary is not a function`, a message that names neither the
 * resolver nor the service. The contract (a synchronous `Transport | null`) is
 * now checked before the value is cached.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { createCatalogClient } from "../../src/catalogClient.ts";
import { defineService } from "../../src/defineService.ts";
import { mapResolver } from "../../src/remoteResolver.ts";
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
const TARGET = "streaming.v1.StreamingService";

function remote(): Transport {
    return createRouterTransport((router) => {
        router.service(StreamingService, {
            echo: (req) => create(ItemSchema, { value: `remote:${req.value}`, sequence: req.sequence }),
            async *server() {},
            client: async () => {
                throw new Error("unused");
            },
            async *bidi() {},
        });
    });
}

/** A server whose only mounted service calls the remote StreamingService; `outcomes` collects each `ctx.call` result. */
function serverWith(resolver: (ctx: { typeName: string }) => unknown) {
    const outcomes: unknown[] = [];
    const server = createServer({
        catalog,
        enabledServices: [EchoService.typeName],
        remoteResolver: resolver as never,
        services: [
            defineService(EchoService, {
                echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                secureEcho: async (_req, ctx) => {
                    try {
                        outcomes.push(await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 })));
                    } catch (error) {
                        outcomes.push(error);
                    }
                    return create(EchoResponseSchema, { message: "", timestamp: 0n });
                },
                rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
            }),
        ],
    });
    const run = () => server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
    return { outcomes, run };
}

function assertInvalidResult(outcome: unknown, expectedInMessage: RegExp): void {
    assert.ok(outcome instanceof ConnectError, `expected a ConnectError, got ${String(outcome)}`);
    assert.strictEqual(outcome.code, Code.Internal);
    assert.ok(outcome.rawMessage.includes(TARGET), `must name the service: ${outcome.rawMessage}`);
    assert.match(outcome.rawMessage, /remoteResolver/);
    assert.match(outcome.rawMessage, expectedInMessage);
    assert.doesNotMatch(outcome.rawMessage, /is not a function/);
}

describe("ctx.call: a remoteResolver result that is not a Transport", () => {
    for (const [label, value, pattern] of [
        ["a string", "not a transport", /string/],
        ["undefined", undefined, /undefined/],
        ["an object without the transport methods", { unary: () => {} }, /object/],
    ] as const) {
        it(`fails with Internal naming the service and the resolver for ${label}`, async () => {
            const { outcomes, run } = serverWith(() => value);
            await run();
            assert.strictEqual(outcomes.length, 1);
            assertInvalidResult(outcomes[0], pattern);
        });
    }

    it("does not cache the invalid value: the resolver is asked again and a later transport works", async () => {
        const good = remote();
        let calls = 0;
        const { outcomes, run } = serverWith(() => (++calls === 1 ? "not a transport" : good));
        await run();
        await run();
        assert.strictEqual(calls, 2, "the resolver must run again after an invalid result");
        assertInvalidResult(outcomes[0], /string/);
        assert.strictEqual((outcomes[1] as Item).value, "remote:x");
    });

    it("says that a Promise is not allowed and leaves no unhandled rejection from it", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            const { outcomes, run } = serverWith(async () => {
                throw new Error("resolver rejected");
            });
            await run();
            await new Promise((resolve) => setTimeout(resolve, 20));
            assertInvalidResult(outcomes[0], /Promise/);
            assert.deepStrictEqual(unhandled, [], "the abandoned promise must not surface as an unhandled rejection");
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("still reports a null result as Unavailable", async () => {
        const { outcomes, run } = serverWith(() => null);
        await run();
        const outcome = outcomes[0];
        assert.ok(outcome instanceof ConnectError);
        assert.strictEqual(outcome.code, Code.Unavailable);
    });
});

describe("server.client(): a remoteResolver result that is not a Transport", () => {
    it("throws Internal naming the service and does not cache the value", () => {
        let calls = 0;
        const server = createServer({
            catalog,
            enabledServices: [],
            services: [],
            remoteResolver: (() => (++calls === 1 ? "nope" : remote())) as never,
        });
        assert.throws(
            () => server.client(StreamingService),
            (error: unknown) => {
                assert.ok(error instanceof ConnectError);
                assert.strictEqual(error.code, Code.Internal);
                assert.ok(error.rawMessage.includes(TARGET));
                return true;
            },
        );
        server.client(StreamingService);
        assert.strictEqual(calls, 2);
    });
});

describe("createCatalogClient: a resolver result that is not a Transport", () => {
    it("rejects with Internal naming the service and does not cache the value", async () => {
        let calls = 0;
        const good = remote();
        const client = createCatalogClient({ catalog, resolver: (() => (++calls === 1 ? "nope" : good)) as never });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 })),
            (error: unknown) => {
                assertInvalidResult(error, /string/);
                return true;
            },
        );
        const ok = await client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }));
        assert.strictEqual(ok.value, "remote:x");
        assert.strictEqual(calls, 2);
    });

    it("reports a mapResolver entry of the wrong type", async () => {
        const client = createCatalogClient({ catalog, resolver: mapResolver({ [StreamingService.typeName]: "not a transport" as never }) });
        await assert.rejects(
            () => client.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 })),
            (error: unknown) => {
                assertInvalidResult(error, /string/);
                return true;
            },
        );
    });
});
