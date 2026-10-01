/**
 * Where a server-level `requestGate` applies to the health protocol.
 *
 * The gRPC Health service is registered on the server's router, so it is an
 * RPC like any other and passes through the gate — over HTTP and in-process.
 * The HTTP health endpoints (`/healthz` and friends) are served by the
 * protocol's HTTP handler outside the router, so the gate never sees them.
 * Operators rely on this boundary when a credential gate is enabled: a
 * Kubernetes HTTP probe keeps working, a gRPC health probe must present
 * whatever the gate requires.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("requestGate coverage for the health protocol", () => {
    let server: Server;
    const gateCalls: string[] = [];

    before(async () => {
        const manager = createHealthcheckManager();
        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ manager, httpEnabled: true })],
            requestGate: (ctx) => {
                gateCalls.push(ctx.method.name);
                throw new ConnectError("unauthenticated", Code.Unauthenticated);
            },
        });
        await server.start();
        // Track one service so the aggregated HTTP status can report SERVING.
        manager.initialize(["test.v1.TestService"]);
        manager.update(ServingStatus.SERVING);
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("rejects the Health Check RPC over HTTP", async () => {
        const health = createClient(Health, createConnectTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}`, httpVersion: "1.1" }));
        await assert.rejects(health.check({ service: "" }), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });

    it("rejects the Health Check RPC in-process", async () => {
        await assert.rejects(server.localClient(Health).check({ service: "" }), (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated);
    });

    it("serves the HTTP health endpoint without invoking the gate", async () => {
        const before = gateCalls.length;
        const res = await fetch(`http://127.0.0.1:${server.address?.port}/healthz`);
        assert.strictEqual(res.status, 200);
        await res.text();
        assert.strictEqual(gateCalls.length, before, "HTTP health endpoints are outside the gate");
    });
});
