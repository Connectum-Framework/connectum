/**
 * Protocol one-time setup across every router a server builds.
 *
 * The HTTP adapter, `server.localClient()` and the catalog's `ctx.call` each
 * materialize their own ConnectRouter. A protocol's `setup` must run exactly
 * once per server regardless of which of these comes first; `register` runs
 * once per router. If `setup` replayed, protocols with one-time side effects
 * (Healthcheck's manager initialization) would corrupt server state on the
 * first in-process call.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import type { ProtocolContext, ProtocolRegistration } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

function countingProtocol(): ProtocolRegistration & { setupCalls: number; registerCalls: number; setupRegistry: ProtocolContext["registry"] | undefined } {
    const state = {
        name: "counting",
        setupCalls: 0,
        registerCalls: 0,
        setupRegistry: undefined as ProtocolContext["registry"] | undefined,
        setup(context: ProtocolContext) {
            state.setupCalls++;
            state.setupRegistry = context.registry;
        },
        register(_router: ConnectRouter) {
            state.registerCalls++;
        },
    };
    return state;
}

/** Echo service whose `secureEcho` performs a catalog call to the locally mounted `echo`. */
const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: async (req, ctx) => {
        const inner = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: `via-catalog:${req.message}` }));
        return create(EchoResponseSchema, { message: inner.message, timestamp: 0n });
    },
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

const catalog = defineCatalog({ [EchoService.typeName]: EchoService });

describe("protocol setup runs once per server", () => {
    it("start() then localClient() then a ctx.call: setup once, register per router", async () => {
        const protocol = countingProtocol();
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [protocol], catalog });
        await server.start();
        try {
            assert.strictEqual(protocol.setupCalls, 1, "setup after start()");
            assert.strictEqual(protocol.registerCalls, 1, "one router: the HTTP adapter");

            const reply = await server.localClient(EchoService).secureEcho({ message: "ping" });
            assert.strictEqual(reply.message, "via-catalog:ping", "the ctx.call must reach the local echo");

            assert.strictEqual(protocol.setupCalls, 1, "setup must not replay for in-process routers");
            assert.strictEqual(protocol.registerCalls, 3, "HTTP adapter + localClient transport + catalog transport");
        } finally {
            await server.stop();
        }
    });

    it("localClient() before start(): setup still runs once in total", async () => {
        const protocol = countingProtocol();
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [protocol], catalog });

        await server.localClient(EchoService).echo({ message: "early" });
        assert.strictEqual(protocol.setupCalls, 1, "setup on the first materialization, before start()");

        await server.start();
        try {
            assert.strictEqual(protocol.setupCalls, 1, "start() must not set up the protocol again");
        } finally {
            await server.stop();
        }
    });

    // A protocol written against the old two-argument `register` must fail to
    // compile rather than silently lose its context; `pnpm typecheck` fails if
    // this assignment ever becomes legal again.
    it("rejects a protocol whose register still expects a context", () => {
        const legacy = {
            name: "legacy",
            register(_router: ConnectRouter, _context: ProtocolContext) {},
        };
        // @ts-expect-error register receives only the router; context moved to setup
        const asProtocol: ProtocolRegistration = legacy;
        assert.strictEqual(asProtocol.name, "legacy");
    });

    // `setup` is optional: a protocol that only registers routes must be served
    // on every router, not just on the HTTP adapter.
    it("serves a protocol without setup over HTTP and in-process", async () => {
        const routesOnly: ProtocolRegistration = {
            name: "routes-only",
            register(router: ConnectRouter) {
                router.service(StreamingService, {
                    echo: (req) => create(ItemSchema, { value: `proto:${req.value}`, sequence: req.sequence }),
                    async *server() {},
                    client: async () => create(CountSchema, { total: 0 }),
                    async *bidi() {},
                });
            },
        };
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [routesOnly], catalog });
        await server.start();
        try {
            const overHttp = await createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` })).echo({ value: "a" });
            const inProcess = await server.localClient(StreamingService).echo({ value: "a" });
            assert.strictEqual(overHttp.value, "proto:a");
            assert.strictEqual(inProcess.value, "proto:a");
        } finally {
            await server.stop();
        }
    });

    it("setup sees the mounted application services", async () => {
        const protocol = countingProtocol();
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [protocol], catalog });
        await server.start();
        try {
            assert.deepStrictEqual(protocol.setupRegistry, [EchoService.file]);
        } finally {
            await server.stop();
        }
    });
});
