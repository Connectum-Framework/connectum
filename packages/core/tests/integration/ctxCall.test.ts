/**
 * ctx.call — declarative cross-service calls from inside a handler.
 *
 * Covers section 4 of the service-catalog change: local dispatch, remote
 * dispatch via the resolver (+ per-(typeName,endpoint) caching), the
 * signal/deadline cascade, and the split error model (FailedPrecondition /
 * Unimplemented / Unavailable / Internal).
 *
 * The fixtures give us two distinct services so a locally-mounted caller can
 * reach a *non-local* target: EchoService is the caller (mounted), and the
 * unary StreamingService.Echo is the remote target.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import type { Context } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { defaultPropagateHeaders } from "../../src/propagateHeaders.ts";
import { singleTransportResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

// Hand-written catalog augmentation (the buf plugin — task 9 — does not exist
// yet). Includes deliberately-bogus keys to exercise the Unimplemented guards.
declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
        "ghost.v1.GhostService/Vanish": { request: EchoRequest; response: EchoResponse };
        "echo.v1.EchoService/Nope": { request: EchoRequest; response: EchoResponse };
    }
}

type SecureImpl = (req: EchoRequest, ctx: Context) => Promise<EchoResponse>;

/** EchoService where `secureEcho` is the caller; `echo` doubles as the local target. */
function makeCaller(secureEcho: SecureImpl) {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho,
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

/** A router-transport serving the unary StreamingService.Echo, tagged with `marker`. */
function makeStreamingRemote(marker: string): Transport {
    return createRouterTransport((router) => {
        router.service(StreamingService, {
            echo: (req) => create(ItemSchema, { value: `${marker}:${req.value}`, sequence: req.sequence }),
            // Streaming methods are unused here; minimal stubs keep the impl total.
            async *server() {},
            client: async () => create(ItemSchema, { value: "", sequence: 0 }) as never,
            async *bidi() {},
        });
    });
}

describe("ctx.call — local dispatch", () => {
    it("dispatches to a locally-mounted service in-process (no socket)", async () => {
        const server = createServer({
            services: [
                makeCaller(async (req, ctx) => {
                    const inner = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: req.message }));
                    return create(EchoResponseSchema, { message: `outer:${inner.message}`, timestamp: 0n });
                }),
            ],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
        });

        const response = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "hi" }));
        assert.strictEqual(response.message, "outer:echo:hi", "inner ctx.call must hit the local Echo handler");
        assert.strictEqual(server.address, null, "no TCP port opened — proves in-process dispatch");
    });
});

describe("ctx.call — remote dispatch via resolver", () => {
    it("routes a non-local target through the resolver-supplied transport", async () => {
        const server = createServer({
            services: [
                makeCaller(async (req, ctx) => {
                    const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }));
                    return create(EchoResponseSchema, { message: `outer:${inner.value}`, timestamp: 0n });
                }),
            ],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: singleTransportResolver(makeStreamingRemote("remote")),
        });

        const response = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(response.message, "outer:remote:x", "must go through the resolved remote transport");
    });

    it("caches the resolver per (typeName, endpoint) — resolved at most once", async () => {
        let resolverCalls = 0;
        const remote = makeStreamingRemote("R");
        const server = createServer({
            services: [
                makeCaller(async (req, ctx) => {
                    const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }));
                    return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
                }),
            ],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: ({ typeName }) => {
                resolverCalls += typeName === StreamingService.typeName ? 1 : 0;
                return remote;
            },
        });

        const client = server.localClient(EchoService);
        const a = await client.secureEcho(create(EchoRequestSchema, { message: "1" }));
        const b = await client.secureEcho(create(EchoRequestSchema, { message: "2" }));
        assert.strictEqual(a.message, "R:1");
        assert.strictEqual(b.message, "R:2");
        assert.strictEqual(resolverCalls, 1, "resolver must be cached after the first ctx.call");
    });
});

describe("ctx.call — signal cascade", () => {
    it("propagates the inbound abort to an in-flight ctx.call (Code.Canceled)", async () => {
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
        });
        const blockingRemote = createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (_req, ctx) =>
                    new Promise<Item>((_resolve, reject) => {
                        started();
                        ctx.signal.addEventListener("abort", () => reject(new ConnectError("aborted by inbound signal", Code.Canceled)));
                    }),
                async *server() {},
                client: async () => create(ItemSchema, { value: "", sequence: 0 }) as never,
                async *bidi() {},
            });
        });

        let captured: unknown;
        const server = createServer({
            services: [
                makeCaller(async (req, ctx) => {
                    try {
                        const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }));
                        return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
                    } catch (err) {
                        captured = err;
                        throw err;
                    }
                }),
            ],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: singleTransportResolver(blockingRemote),
        });

        const controller = new AbortController();
        const pending = server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { signal: controller.signal });

        await startedPromise; // inner ctx.call has reached the (blocking) remote handler
        controller.abort();

        await assert.rejects(pending);
        assert.ok(captured instanceof ConnectError, `inner error must be a ConnectError, got: ${String(captured)}`);
        assert.strictEqual((captured as ConnectError).code, Code.Canceled, "cascade must cancel the downstream call");
    });
});

describe("ctx.call — deadline cascade", () => {
    // The remote echoes back the remaining deadline it observed (in ms), so the
    // test can assert what was injected/clamped.
    function makeDeadlineRemote(): Transport {
        return createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (_req, ctx) => create(ItemSchema, { value: String(ctx.timeoutMs() ?? -1), sequence: 0 }),
                async *server() {},
                client: async () => create(ItemSchema, { value: "", sequence: 0 }) as never,
                async *bidi() {},
            });
        });
    }

    function makeServer(secure: SecureImpl) {
        return createServer({
            services: [makeCaller(secure)],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: singleTransportResolver(makeDeadlineRemote()),
        });
    }

    it("injects the remaining inbound deadline when timeoutMs is omitted", async () => {
        const server = makeServer(async (req, ctx) => {
            const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }));
            return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { timeoutMs: 5_000 });
        const observed = Number(res.message);
        assert.ok(observed > 4_000 && observed <= 5_000, `downstream should see ~5000ms remaining, saw ${observed}`);
    });

    it("clamps an over-long override to the remaining deadline (cannot extend)", async () => {
        const server = makeServer(async (req, ctx) => {
            const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }), { timeoutMs: 999_999 });
            return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { timeoutMs: 2_000 });
        const observed = Number(res.message);
        assert.ok(observed > 0 && observed <= 2_000, `override must be clamped to <=2000ms, saw ${observed}`);
    });

    it("honours a shorter override", async () => {
        const server = makeServer(async (req, ctx) => {
            const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }), { timeoutMs: 500 });
            return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
        });
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { timeoutMs: 5_000 });
        const observed = Number(res.message);
        assert.ok(observed > 0 && observed <= 500, `shorter override must win, saw ${observed}`);
    });
});

describe("ctx.call — error model (Q15 split: operational → ConnectError)", () => {
    async function captureCallError(secure: SecureImpl, configure: (base: Parameters<typeof createServer>[0]) => Parameters<typeof createServer>[0]): Promise<unknown> {
        let captured: unknown;
        const wrapped: SecureImpl = async (req, ctx) => {
            try {
                return await secure(req, ctx);
            } catch (err) {
                captured = err;
                throw err;
            }
        };
        const base: Parameters<typeof createServer>[0] = { services: [makeCaller(wrapped)] };
        const server = createServer(configure(base));
        await server
            .localClient(EchoService)
            .secureEcho(create(EchoRequestSchema, { message: "x" }))
            .catch(() => {});
        return captured;
    }

    it("no catalog configured → FailedPrecondition", async () => {
        const err = await captureCallError(
            async (_req, ctx) => {
                await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "y" }));
                return create(EchoResponseSchema, { message: "", timestamp: 0n });
            },
            (base) => base, // no catalog
        );
        assert.ok(err instanceof ConnectError, `got: ${String(err)}`);
        assert.strictEqual((err as ConnectError).code, Code.FailedPrecondition);
    });

    it("unknown service in the catalog → Unimplemented", async () => {
        const err = await captureCallError(
            async (_req, ctx) => {
                await ctx.call("ghost.v1.GhostService/Vanish", create(EchoRequestSchema, { message: "y" }));
                return create(EchoResponseSchema, { message: "", timestamp: 0n });
            },
            (base) => ({ ...base, catalog: defineCatalog({ [EchoService.typeName]: EchoService }) }),
        );
        assert.strictEqual((err as ConnectError).code, Code.Unimplemented);
    });

    it("known service, unknown method → Unimplemented", async () => {
        const err = await captureCallError(
            async (_req, ctx) => {
                await ctx.call("echo.v1.EchoService/Nope", create(EchoRequestSchema, { message: "y" }));
                return create(EchoResponseSchema, { message: "", timestamp: 0n });
            },
            (base) => ({ ...base, catalog: defineCatalog({ [EchoService.typeName]: EchoService }) }),
        );
        assert.strictEqual((err as ConnectError).code, Code.Unimplemented);
    });

    it("resolver returns null for a remote target → Unavailable", async () => {
        const err = await captureCallError(
            async (_req, ctx) => {
                await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "y", sequence: 0 }));
                return create(EchoResponseSchema, { message: "", timestamp: 0n });
            },
            (base) => ({
                ...base,
                catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
                remoteResolver: () => null,
            }),
        );
        assert.strictEqual((err as ConnectError).code, Code.Unavailable);
    });

    it("resolver throws → Internal (wraps the cause)", async () => {
        const boom = new Error("resolver exploded");
        const err = await captureCallError(
            async (_req, ctx) => {
                await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "y", sequence: 0 }));
                return create(EchoResponseSchema, { message: "", timestamp: 0n });
            },
            (base) => ({
                ...base,
                catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
                remoteResolver: () => {
                    throw boom;
                },
            }),
        );
        assert.ok(err instanceof ConnectError, `got: ${String(err)}`);
        assert.strictEqual((err as ConnectError).code, Code.Internal);
        assert.strictEqual((err as ConnectError).cause, boom, "original cause must be preserved");
    });
});

describe("ctx.call — header propagation", () => {
    const HEADER = "x-trace-test";

    function makeHeaderRemote(): Transport {
        return createRouterTransport((router) => {
            router.service(StreamingService, {
                echo: (_req, ctx) => create(ItemSchema, { value: ctx.requestHeader.get(HEADER) ?? "none", sequence: 0 }),
                async *server() {},
                client: async () => create(ItemSchema, { value: "", sequence: 0 }) as never,
                async *bidi() {},
            });
        });
    }

    function makeServer(propagateHeaders: readonly string[] | undefined, secure: SecureImpl) {
        const base: Parameters<typeof createServer>[0] = {
            services: [makeCaller(secure)],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService }),
            remoteResolver: singleTransportResolver(makeHeaderRemote()),
        };
        return createServer(propagateHeaders ? { ...base, propagateHeaders } : base);
    }

    const relay: SecureImpl = async (req, ctx) => {
        const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }));
        return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
    };

    it("propagates nothing by default", async () => {
        const server = makeServer(undefined, relay);
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: { [HEADER]: "abc" } });
        assert.strictEqual(res.message, "none", "no inbound header should leak without propagateHeaders");
    });

    it("propagates allow-listed inbound headers", async () => {
        const server = makeServer([HEADER], relay);
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: { [HEADER]: "abc" } });
        assert.strictEqual(res.message, "abc");
    });

    it("explicit CallOptions.headers win over propagated values", async () => {
        const overriding: SecureImpl = async (req, ctx) => {
            const inner = await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: req.message, sequence: 0 }), { headers: { [HEADER]: "override" } });
            return create(EchoResponseSchema, { message: inner.value, timestamp: 0n });
        };
        const server = makeServer([HEADER], overriding);
        const res = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: { [HEADER]: "abc" } });
        assert.strictEqual(res.message, "override");
    });

    it("defaultPropagateHeaders is the W3C trace-context set", () => {
        assert.deepStrictEqual([...defaultPropagateHeaders], ["traceparent", "tracestate"]);
    });
});

describe("ctx.call — open items (escalated, not yet locked)", () => {
    // Q15 / task 4.10: ctx.call is structurally impossible outside a handler —
    // a Context only exists where a HandlerContext exists. There is no
    // free-standing entrypoint to test; behaviour is not a deferred feature.
    it.todo("ctx.call outside a handler context — structurally impossible; awaiting product decision");

    // Disputed cell: construction-time server.client(Desc) with no catalog.
    // spec.md/tasks 7.4 prose says FailedPrecondition; the user-approved Q15
    // split (and current Server.ts) throws CatalogConfigError. Stale prose must
    // be reconciled before this is asserted as a contract.
    it.todo("server.client(Desc) with no catalog — CatalogConfigError vs FailedPrecondition pending spec reconciliation");
});
