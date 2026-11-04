/**
 * Overlapping connect() calls on one adapter share one producer instead of leaking one.
 *
 * The leak is observable from outside: the overwritten producer keeps its sockets and timers after
 * disconnect(), so the process stays alive. The test counts the process's open TCP handles, so this file
 * holds no other connection.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/ConcurrentConnect.integration.test.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const openTcpHandles = (): number => process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe("Kafka adapter overlapping connect() calls", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    it("leaves no open connection behind after disconnect()", async () => {
        const adapter = KafkaAdapter({ brokers, logLevel: "nothing" });
        await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
        await adapter.publish(`concurrent-connect.${Date.now()}`, new Uint8Array([1]));
        await adapter.disconnect();
        await waitFor(() => openTcpHandles() === 0, `all TCP handles closed (still open: ${openTcpHandles()})`);
    });

    it("returns from the second overlapping call only once the adapter can publish", async () => {
        const adapter = KafkaAdapter({ brokers, logLevel: "nothing" });
        const first = adapter.connect();
        await adapter.connect();
        await adapter.publish(`concurrent-connect.${Date.now()}`, new Uint8Array([1]));
        await first;
        await adapter.connect();
        await adapter.disconnect();
    });

    it("disconnect() during connect() waits for it and leaves nothing open", async () => {
        const adapter = KafkaAdapter({ brokers, logLevel: "nothing" });
        const connecting = adapter.connect();
        await adapter.disconnect();
        await connecting;
        await assert.rejects(adapter.publish("t", new Uint8Array([1])), { message: "KafkaAdapter: not connected" });
        await waitFor(() => openTcpHandles() === 0, `all TCP handles closed (still open: ${openTcpHandles()})`);
    });
});

describe("Kafka adapter overlapping connect() calls to an unreachable broker", () => {
    async function closedPort(): Promise<number> {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
    }

    it("rejects all of them and the next connect() starts a fresh attempt", async () => {
        const port = await closedPort();
        const adapter = KafkaAdapter({ brokers: [`127.0.0.1:${port}`], logLevel: "nothing", retry: { retries: 0 } });
        const results = await Promise.allSettled([adapter.connect(), adapter.connect()]);
        assert.deepEqual(
            results.map((r) => r.status),
            ["rejected", "rejected"],
        );
        const reasons = results.map((r) => (r as PromiseRejectedResult).reason);
        assert.equal(reasons[0], reasons[1], "both calls get the error of the one attempt");
        await assert.rejects(adapter.connect(), /Connection error/, "a failed attempt is not remembered");
    });
});
