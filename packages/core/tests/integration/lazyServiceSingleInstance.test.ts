/**
 * A lazily defined service must be instantiated once per server, no matter how
 * many routers the server materializes.
 *
 * The HTTP adapter, `server.localClient` and the catalog's `ctx.call` each build
 * their own ConnectRouter from the same route registration. If the factory ran
 * on every registration, HTTP and in-process callers would talk to different
 * implementation instances (diverging in-memory state, duplicated resources such
 * as connection pools) — breaking transport parity.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { defineLazyService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

describe("defineLazyService — single instance per server", () => {
    it("runs the factory once across the HTTP adapter and an in-process client", async () => {
        let factoryCalls = 0;
        const echo = defineLazyService(EchoService, () => {
            factoryCalls++;
            const instance = factoryCalls;
            return {
                echo: (req) => create(EchoResponseSchema, { message: `${instance}:${req.message}`, timestamp: 0n }),
                secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            };
        });

        const server = createServer({ services: [echo], port: 0, allowHTTP1: false });
        await server.start();
        try {
            const reply = await server.localClient(EchoService).echo({ message: "ping" });
            assert.strictEqual(factoryCalls, 1, "factory must run once per server");
            assert.strictEqual(reply.message, "1:ping", "in-process calls must reach the same instance the HTTP adapter uses");
        } finally {
            await server.stop();
        }
    });

    // The memo is per server, not per definition: sharing one definition
    // between two servers must not make them share state.
    it("gives each server its own instance of a shared definition", async () => {
        let factoryCalls = 0;
        const echo = defineLazyService(EchoService, () => {
            factoryCalls++;
            return {
                echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            };
        });

        const first = createServer({ services: [echo] });
        const second = createServer({ services: [echo] });
        await first.localClient(EchoService).echo({ message: "a" });
        await second.localClient(EchoService).echo({ message: "b" });

        assert.strictEqual(factoryCalls, 2, "one instance per server");
    });

    // A service served by another process must not build its local dependencies.
    it("never runs the factory for a service excluded by enabledServices", async () => {
        let factoryCalls = 0;
        const echo = defineLazyService(EchoService, () => {
            factoryCalls++;
            return {
                echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            };
        });

        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, enabledServices: [] });
        await server.start();
        try {
            assert.strictEqual(factoryCalls, 0);
        } finally {
            await server.stop();
        }
    });
});
