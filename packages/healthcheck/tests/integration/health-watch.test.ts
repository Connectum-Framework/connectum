/**
 * Integration tests for Health.Watch and per-service Health.Check over the wire
 *
 * grpc.health.v1 Watch: the first message is the current status, later
 * messages only on a change, an unknown service is reported as SERVICE_UNKNOWN
 * without ending the call, and the empty name stands for overall health.
 *
 * Transport: createGrpcTransport (HTTP/2, required for streaming).
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const SERVICE = "watch.v1.Tracked";

describe("Health.Watch and per-service Health.Check over gRPC", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof Health>>;
    let manager: ReturnType<typeof createHealthcheckManager>;

    before(async () => {
        manager = createHealthcheckManager();
        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ manager, watchInterval: 20 })],
            interceptors: [],
            allowHTTP1: false,
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    /**
     * Open a Watch call and collect the statuses it delivers. `until` waits for
     * a number of messages and fails with what was actually received.
     */
    function watch(service: string) {
        const controller = new AbortController();
        const received: ServingStatus[] = [];
        const finished = (async () => {
            try {
                for await (const update of client.watch({ service }, { signal: controller.signal })) {
                    received.push(update.status);
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    throw err;
                }
            }
        })();
        return {
            received,
            async until(count: number): Promise<void> {
                const deadline = Date.now() + 3000;
                while (received.length < count) {
                    if (Date.now() > deadline) {
                        assert.fail(`expected ${count} Watch messages, received ${JSON.stringify(received)}`);
                    }
                    await delay(5);
                }
            },
            async stop(): Promise<void> {
                controller.abort();
                await finished;
            },
        };
    }

    it("Check answers NOT_SERVING for a tracked service that is not serving and UNKNOWN for one not yet reported", async () => {
        manager.initialize([SERVICE, "watch.v1.Other"]);
        manager.update(ServingStatus.NOT_SERVING, SERVICE);

        assert.strictEqual((await client.check({ service: SERVICE })).status, ServingStatus.NOT_SERVING);
        assert.strictEqual((await client.check({ service: "watch.v1.Other" })).status, ServingStatus.UNKNOWN);
    });

    it("sends the current status first and every later change, and nothing while the status holds", async () => {
        manager.initialize([SERVICE]);
        manager.update(ServingStatus.NOT_SERVING, SERVICE);
        const call = watch(SERVICE);
        try {
            await call.until(1);
            // Many polling intervals pass without a change.
            await delay(200);
            assert.deepStrictEqual(call.received, [ServingStatus.NOT_SERVING]);

            manager.update(ServingStatus.SERVING, SERVICE);
            await call.until(2);
            manager.update(ServingStatus.NOT_SERVING, SERVICE);
            await call.until(3);
            await delay(100);

            assert.deepStrictEqual(call.received, [ServingStatus.NOT_SERVING, ServingStatus.SERVING, ServingStatus.NOT_SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("watches overall health for the empty service name", async () => {
        manager.initialize([SERVICE]);
        manager.update(ServingStatus.NOT_SERVING);
        const call = watch("");
        try {
            await call.until(1);
            manager.update(ServingStatus.SERVING);
            await call.until(2);

            assert.deepStrictEqual(call.received, [ServingStatus.NOT_SERVING, ServingStatus.SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("reports SERVICE_UNKNOWN for an untracked service, keeps the call open and reports it once it appears", async () => {
        manager.initialize([SERVICE]);
        const call = watch("watch.v1.Later");
        try {
            await call.until(1);
            await delay(100);
            assert.deepStrictEqual(call.received, [ServingStatus.SERVICE_UNKNOWN], "the call stays open and silent while the service is unknown");

            manager.initialize([SERVICE, "watch.v1.Later"]);
            manager.update(ServingStatus.SERVING, "watch.v1.Later");
            await call.until(2);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVICE_UNKNOWN, ServingStatus.SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("reports SERVICE_UNKNOWN to a watcher when the tracked service disappears", async () => {
        manager.initialize([SERVICE]);
        manager.update(ServingStatus.SERVING, SERVICE);
        const call = watch(SERVICE);
        try {
            await call.until(1);

            manager.initialize([]);
            await call.until(2);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVING, ServingStatus.SERVICE_UNKNOWN]);
        } finally {
            await call.stop();
        }
    });
});
