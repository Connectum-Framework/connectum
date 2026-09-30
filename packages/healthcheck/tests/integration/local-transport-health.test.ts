/**
 * Overall health must not change when an in-process transport is created on a
 * running server.
 *
 * `server.localClient` and the catalog's `ctx.call` build their own
 * ConnectRouter from the server's route registration. If the Healthcheck
 * protocol re-initialized its manager on every router, the second pass would
 * see the protocol's own `grpc.health.v1.Health` file in the now-populated
 * registry, drop the services the application tracks and add Health itself as
 * UNKNOWN — overall status falls out of SERVING and a readiness probe starts
 * failing after the first local call.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineCatalog, defineService } from "@connectum/core";
// The core package's test fixture: the healthcheck package ships no proto of
// its own besides Health, and a catalog call needs a second service.
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../core/tests/fixtures/echo/v1/echo_pb.ts";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

/** Stands in for an application service tracked by the manager. */
const APP_SERVICE = "test.v1.TestService";

describe("Healthcheck + in-process transport on a running server", () => {
    let server: Server;
    let manager: ReturnType<typeof createHealthcheckManager>;
    let health: ReturnType<typeof createClient<typeof Health>>;

    before(async () => {
        manager = createHealthcheckManager();
        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ manager })],
            allowHTTP1: false,
        });
        await server.start();
        health = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
        manager.initialize([APP_SERVICE]);
        manager.update(ServingStatus.SERVING);
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("keeps overall SERVING and the tracked service set after the first localClient()", async () => {
        const overallBefore = await health.check({ service: "" });
        assert.strictEqual(overallBefore.status, ServingStatus.SERVING, "precondition: overall SERVING after update()");

        const local = await server.localClient(Health).check({ service: APP_SERVICE });
        assert.strictEqual(local.status, ServingStatus.SERVING, "the in-process call itself must succeed");

        const overallAfter = await health.check({ service: "" });
        assert.strictEqual(overallAfter.status, ServingStatus.SERVING, "overall health must stay SERVING after a local call");
        assert.deepStrictEqual([...manager.getAllStatuses().keys()], [APP_SERVICE], "creating a local transport must not change the tracked service set");
    });
});

// The catalog transport behind `ctx.call` is built lazily on the first call,
// i.e. typically long after the service reported SERVING.
describe("Healthcheck + first ctx.call on a running server", () => {
    it("keeps overall SERVING after the catalog transport is built", async () => {
        const manager = createHealthcheckManager();
        const echo = defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            secureEcho: async (req, ctx) => {
                const inner = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: req.message }));
                return create(EchoResponseSchema, { message: inner.message, timestamp: 0n });
            },
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const server = createServer({
            services: [echo],
            port: 0,
            protocols: [Healthcheck({ manager })],
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            allowHTTP1: false,
        });
        await server.start();
        try {
            const transport = createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` });
            const health = createClient(Health, transport);
            manager.update(ServingStatus.SERVING);
            assert.strictEqual((await health.check({ service: "" })).status, ServingStatus.SERVING, "precondition");

            const reply = await createClient(EchoService, transport).secureEcho({ message: "ping" });
            assert.strictEqual(reply.message, "ping", "the ctx.call must reach the local echo");

            assert.strictEqual((await health.check({ service: "" })).status, ServingStatus.SERVING, "overall health must stay SERVING after the first ctx.call");
            assert.deepStrictEqual([...manager.getAllStatuses().keys()], [EchoService.typeName], "only the application service is tracked");
        } finally {
            await server.stop();
        }
    });
});
