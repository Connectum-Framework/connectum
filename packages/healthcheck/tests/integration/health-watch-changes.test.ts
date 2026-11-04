/**
 * Health.Watch delivers every change, not a sample once per polling interval.
 *
 * The documented contract is "send a new message whenever the service's
 * serving status changes". A change made and reverted inside one interval used
 * to be invisible to watchers. The interval below is far longer than any test
 * wait, so everything a client receives here arrived through the manager's
 * change notifications. Assertions go through a real gRPC client over HTTP/2.
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
import { createHealthcheckManager, HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

const LONG_INTERVAL = 60_000;

describe("Health.Watch change delivery", () => {
    let server: Server;
    let client: ReturnType<typeof createClient<typeof Health>>;
    const manager = createHealthcheckManager();

    before(async () => {
        server = createServer({ services: [], port: 0, protocols: [Healthcheck({ manager, watchInterval: LONG_INTERVAL })], allowHTTP1: false });
        await server.start();
        client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
    });

    after(async () => {
        await server?.stop();
    });

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
            async until(count: number, timeoutMs = 3000): Promise<void> {
                const deadline = Date.now() + timeoutMs;
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

    it("delivers NOT_SERVING and SERVING when a service is set down and up within one interval", async () => {
        manager.set("db", ServingStatus.SERVING);
        const call = watch("db");
        try {
            await call.until(1);

            manager.set("db", ServingStatus.NOT_SERVING);
            manager.set("db", ServingStatus.SERVING);
            await call.until(3);
            await delay(50);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("delivers a single change at once, long before the interval elapses", async () => {
        manager.set("db", ServingStatus.SERVING);
        const call = watch("db");
        try {
            await call.until(1);

            manager.set("db", ServingStatus.NOT_SERVING);
            await call.until(2, 1000);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVING, ServingStatus.NOT_SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("keeps the order of a longer burst", async () => {
        manager.set("db", ServingStatus.SERVING);
        const call = watch("db");
        try {
            await call.until(1);

            manager.set("db", ServingStatus.NOT_SERVING);
            manager.set("db", ServingStatus.UNKNOWN);
            manager.set("db", ServingStatus.SERVING);
            manager.set("db", ServingStatus.NOT_SERVING);
            await call.until(5);

            assert.deepStrictEqual(call.received, [
                ServingStatus.SERVING,
                ServingStatus.NOT_SERVING,
                ServingStatus.UNKNOWN,
                ServingStatus.SERVING,
                ServingStatus.NOT_SERVING,
            ]);
        } finally {
            await call.stop();
        }
    });

    it("sends nothing for a change of another service or a repeated status", async () => {
        manager.set("db", ServingStatus.SERVING);
        manager.set("other", ServingStatus.SERVING);
        const call = watch("db");
        try {
            await call.until(1);

            manager.set("other", ServingStatus.NOT_SERVING);
            manager.set("db", ServingStatus.SERVING);
            await delay(150);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("delivers each change of overall health to a watcher of the empty name", async () => {
        manager.clear();
        manager.set("a", ServingStatus.SERVING);
        manager.set("b", ServingStatus.SERVING);
        const call = watch("");
        try {
            await call.until(1);

            manager.set("b", ServingStatus.NOT_SERVING);
            manager.set("b", ServingStatus.SERVING);
            await call.until(3);

            assert.deepStrictEqual(call.received, [ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVING]);
        } finally {
            await call.stop();
        }
    });

    it("serves two watchers of one service independently", async () => {
        manager.clear();
        manager.set("db", ServingStatus.SERVING);
        const first = watch("db");
        const second = watch("db");
        try {
            await first.until(1);
            await second.until(1);

            manager.set("db", ServingStatus.NOT_SERVING);
            manager.set("db", ServingStatus.SERVING);
            await first.until(3);
            await second.until(3);

            assert.deepStrictEqual(first.received, [ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVING]);
            assert.deepStrictEqual(second.received, first.received);
        } finally {
            await first.stop();
            await second.stop();
        }
    });

});

// A Watch subscribes to the manager for as long as the call is open. A call
// that ended without releasing its subscription would keep a closed stream's
// queue alive and grow with every reconnect of a prober.
describe("Health.Watch subscription lifetime", () => {
    class CountingManager extends HealthcheckManager {
        open = 0;
        override subscribe(listener: () => void): () => void {
            this.open++;
            const unsubscribe = super.subscribe(listener);
            return () => {
                this.open--;
                unsubscribe();
            };
        }
    }

    it("releases the subscription when the client ends the call", async () => {
        const manager = new CountingManager();
        manager.set("db", ServingStatus.SERVING);
        const server = createServer({ services: [], port: 0, protocols: [Healthcheck({ manager, watchInterval: LONG_INTERVAL })], allowHTTP1: false });
        await server.start();
        try {
            const client = createClient(Health, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
            const controller = new AbortController();
            const stream = client.watch({ service: "db" }, { signal: controller.signal })[Symbol.asyncIterator]();
            await stream.next();
            assert.strictEqual(manager.open, 1, "an open Watch holds one subscription");

            controller.abort();
            const deadline = Date.now() + 2000;
            while (manager.open > 0 && Date.now() < deadline) {
                await delay(5);
            }

            assert.strictEqual(manager.open, 0, "a finished Watch must release its subscription");
        } finally {
            await server.stop();
        }
    });
});
