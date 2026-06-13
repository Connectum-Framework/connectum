/**
 * Integration tests for RPC-less worker health components
 *
 * The adopter scenario this capability exists for: a worker service with no
 * public RPCs (`services: []`) must be able to become SERVING for
 * docker-compose `service_healthy` gating.
 *
 * Flow under test:
 * 1. register("process") BEFORE server start
 * 2. Healthcheck protocol initialize() must NOT clobber the component
 * 3. set("process", SERVING) on ready
 * 4. /healthz returns 200; gRPC Check("process") returns SERVING
 * 5. Watch("process") observes status transitions
 *
 * Transport: createGrpcTransport (HTTP/2, required for streaming).
 */

import assert from "node:assert";
import http2 from "node:http2";
import { after, before, describe, it } from "node:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

/** Fetch an HTTP health endpoint over h2c and return the status code. */
function httpStatus(baseUrl: string, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const session = http2.connect(baseUrl);
        session.on("error", reject);
        const req = session.request({ ":path": path });
        req.on("response", (headers) => {
            const status = Number(headers[":status"] ?? 0);
            req.close();
            session.close();
            resolve(status);
        });
        req.on("error", reject);
        req.end();
    });
}

describe("RPC-less worker health components", () => {
    let server: Server;
    let serverUrl: string;
    let manager: ReturnType<typeof createHealthcheckManager>;

    before(async () => {
        manager = createHealthcheckManager();

        // Register the process component BEFORE server start: protocol
        // initialization must preserve it (service-slice replacement).
        manager.register("process");

        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager, watchInterval: 50 })],
            interceptors: [],
            allowHTTP1: false,
        });

        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        serverUrl = `http://localhost:${port}`;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("component registered before start survives protocol initialization", () => {
        assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.UNKNOWN);
    });

    it("/healthz is 503 while the process component is UNKNOWN", async () => {
        assert.strictEqual(await httpStatus(serverUrl, "/healthz"), 503);
    });

    it("worker becomes healthy after set(process, SERVING)", async () => {
        manager.set("process", ServingStatus.SERVING);

        // HTTP readiness
        assert.strictEqual(await httpStatus(serverUrl, "/healthz"), 200);

        // gRPC Check by component name
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        const byName = await client.check({ service: "process" });
        assert.strictEqual(byName.status, ServingStatus.SERVING);

        // Overall health (empty service name)
        const overall = await client.check({ service: "" });
        assert.strictEqual(overall.status, ServingStatus.SERVING);
    });

    it("watch stream observes component transitions", async () => {
        manager.set("process", ServingStatus.SERVING);

        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        const controller = new AbortController();
        const received: ServingStatus[] = [];

        const watching = (async () => {
            try {
                for await (const update of client.watch({ service: "process" }, { signal: controller.signal })) {
                    received.push(update.status);
                    if (received.length >= 2) {
                        controller.abort();
                    }
                }
            } catch {
                // AbortError on cancel is expected
            }
        })();

        // Give the stream time to deliver the initial status, then flip
        await new Promise((resolve) => setTimeout(resolve, 100));
        manager.set("process", ServingStatus.NOT_SERVING);

        await watching;

        assert.strictEqual(received[0], ServingStatus.SERVING, "initial status");
        assert.strictEqual(received[1], ServingStatus.NOT_SERVING, "transition observed");
    });

    it("NOT_SERVING component turns /healthz back to 503 (shutdown semantics)", async () => {
        manager.set("process", ServingStatus.NOT_SERVING);

        assert.strictEqual(await httpStatus(serverUrl, "/healthz"), 503);
    });
});
