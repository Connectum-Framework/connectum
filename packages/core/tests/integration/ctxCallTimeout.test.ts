/**
 * `CallOptions.timeoutMs` on catalog calls.
 *
 * A caller may shorten the inherited deadline, never lift it. A zero, negative
 * or non-finite value used to be handed to the transport, where "no deadline"
 * is the meaning of a non-positive timeout, so the callee lost the limit the
 * chain was running under. These tests drive a real nested call and read the
 * deadline the callee sees.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { createCatalogClient } from "../../src/catalogClient.ts";
import type { CallOptions } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { singleTransportResolver } from "../../src/remoteResolver.ts";
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

interface Harness {
    /** What the callee saw: its `ctx.timeoutMs()`, one entry per invocation. */
    readonly seen: Array<number | undefined>;
    /** Run `secureEcho` on the caller with the given inbound deadline and call options for the nested call. */
    run(options: CallOptions | undefined, inboundTimeoutMs?: number): Promise<string>;
}

/** Caller (`EchoService.secureEcho`) forwards one `ctx.call` to the local `EchoService.echo`, which reports the deadline it runs under. */
function harness(): Harness {
    const seen: Array<number | undefined> = [];
    let nextOptions: CallOptions | undefined;
    const server = createServer({
        catalog,
        services: [
            defineService(EchoService, {
                echo: (_req, ctx) => {
                    seen.push(ctx.timeoutMs());
                    return create(EchoResponseSchema, { message: String(ctx.timeoutMs()), timestamp: 0n });
                },
                secureEcho: async (_req, ctx) => {
                    const inner = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }), nextOptions);
                    return create(EchoResponseSchema, { message: inner.message, timestamp: 0n });
                },
                rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
            }),
        ],
    });
    return {
        seen,
        async run(options, inboundTimeoutMs = 2000) {
            nextOptions = options;
            const response = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }), { timeoutMs: inboundTimeoutMs });
            return response.message;
        },
    };
}

describe("ctx.call timeoutMs", () => {
    it("injects the remaining inbound deadline when the option is omitted", async () => {
        const h = harness();
        await h.run(undefined);
        const [seen] = h.seen;
        assert.ok(seen !== undefined && seen > 1000 && seen <= 2000, `the callee must see the inherited deadline, saw ${String(seen)}`);
    });

    it("shortens the inherited deadline with a smaller positive value", async () => {
        const h = harness();
        await h.run({ timeoutMs: 500 });
        const [seen] = h.seen;
        assert.ok(seen !== undefined && seen > 0 && seen <= 500, `the callee must see at most 500 ms, saw ${String(seen)}`);
    });

    it("does not extend the inherited deadline with a larger value", async () => {
        const h = harness();
        await h.run({ timeoutMs: 60_000 });
        const [seen] = h.seen;
        assert.ok(seen !== undefined && seen <= 2000, `the callee must stay under the inbound deadline, saw ${String(seen)}`);
    });

    for (const [label, value] of [
        ["zero", 0],
        ["negative", -5],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["a string", "500" as unknown as number],
    ] as const) {
        it(`rejects ${label} with InvalidArgument naming timeoutMs, without calling the callee`, async () => {
            const h = harness();
            await assert.rejects(
                () => h.run({ timeoutMs: value }),
                (error: unknown) => {
                    const err = ConnectError.from(error);
                    assert.strictEqual(err.code, Code.InvalidArgument);
                    assert.match(err.rawMessage, /timeoutMs/);
                    return true;
                },
            );
            assert.deepStrictEqual(h.seen, [], "the callee must not run with a lifted deadline");
        });
    }

    it("fails with DeadlineExceeded, without calling the callee, when the inbound deadline has already passed", async () => {
        const seen: Array<number | undefined> = [];
        let outcome: unknown = "not run";
        let release: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = createServer({
            catalog,
            services: [
                defineService(EchoService, {
                    echo: (_req, ctx) => {
                        seen.push(ctx.timeoutMs());
                        return create(EchoResponseSchema, { message: "", timestamp: 0n });
                    },
                    secureEcho: async (_req, ctx) => {
                        // Outlive the 40 ms inbound deadline, then call: nothing is left to hand on.
                        await new Promise((resolve) => setTimeout(resolve, 120));
                        try {
                            await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }));
                            outcome = "resolved";
                        } catch (error) {
                            outcome = error;
                        }
                        release();
                        return create(EchoResponseSchema, { message: "", timestamp: 0n });
                    },
                    rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                }),
            ],
        });
        await server
            .localClient(EchoService)
            .secureEcho(create(EchoRequestSchema, { message: "go" }), { timeoutMs: 40 })
            .catch(() => {});
        await finished;
        assert.ok(outcome instanceof ConnectError, `ctx.call must reject, got ${String(outcome)}`);
        assert.strictEqual(outcome.code, Code.DeadlineExceeded);
        assert.deepStrictEqual(seen, [], "the callee must not run once the deadline has passed");
    });
});

describe("ctx.stream timeoutMs", () => {
    it("rejects a non-positive value on iteration with InvalidArgument", async () => {
        let caught: unknown;
        const server = createServer({
            catalog,
            services: [
                defineService(StreamingService, {
                    echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
                    async *server() {
                        yield create(ItemSchema, { value: "never", sequence: 0 });
                    },
                    client: async () => {
                        throw new Error("unused");
                    },
                    async *bidi() {},
                }),
                defineService(EchoService, {
                    echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                    secureEcho: async (_req, ctx) => {
                        try {
                            for await (const _item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "v", sequence: 1 }), { timeoutMs: 0 })) {
                                // no item may arrive
                            }
                        } catch (error) {
                            caught = error;
                        }
                        return create(EchoResponseSchema, { message: "", timestamp: 0n });
                    },
                    rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
                }),
            ],
        });
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }), { timeoutMs: 2000 });
        assert.ok(caught instanceof ConnectError, "iteration must reject");
        assert.strictEqual(caught.code, Code.InvalidArgument);
        assert.match(caught.rawMessage, /timeoutMs/);
    });
});

describe("createCatalogClient timeoutMs", () => {
    function client() {
        const calls: number[] = [];
        const remote = createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (req, ctx) => {
                    calls.push(ctx.timeoutMs() ?? -1);
                    return create(ItemSchema, { value: req.value, sequence: req.sequence });
                },
                async *server() {},
                client: async () => {
                    throw new Error("unused");
                },
                async *bidi() {},
            });
        });
        return { calls, client: createCatalogClient({ catalog, resolver: singleTransportResolver(remote) }) };
    }

    it("passes a positive value to the callee", async () => {
        const { calls, client: c } = client();
        await c.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }), { timeoutMs: 800 });
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0] !== undefined && calls[0] > 0 && calls[0] <= 800, `callee deadline, saw ${String(calls[0])}`);
    });

    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        it(`rejects ${String(value)} with InvalidArgument and does not call the callee`, async () => {
            const { calls, client: c } = client();
            await assert.rejects(
                () => c.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "x", sequence: 0 }), { timeoutMs: value }),
                (error: unknown) => {
                    const err = ConnectError.from(error);
                    assert.strictEqual(err.code, Code.InvalidArgument);
                    assert.match(err.rawMessage, /timeoutMs/);
                    return true;
                },
            );
            assert.deepStrictEqual(calls, []);
        });
    }
});
