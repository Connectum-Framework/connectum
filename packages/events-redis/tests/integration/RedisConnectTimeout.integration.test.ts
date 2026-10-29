/**
 * The wait for a ready connection is bounded on the blocking connection of a subscription too.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. A TCP proxy in front of it relays the
 * first connection (the adapter's publishing connection) and accepts every later one without ever
 * answering it, the way a wedged proxy treats the connection that subscribe() opens for XREADGROUP.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, it } from "node:test";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

describe("Redis connect timeout on the subscription connection", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const target = new URL(REDIS_TEST_URL ?? "redis://127.0.0.1:6379");

    it("rejects subscribe() when the blocking connection never becomes ready, and the adapter stays usable", async () => {
        const sockets = new Set<net.Socket>();
        let connections = 0;
        const proxy = net.createServer((client) => {
            connections += 1;
            sockets.add(client);
            client.on("error", () => undefined);
            client.on("close", () => sockets.delete(client));
            if (connections === 1) {
                const upstream = net.connect(Number(target.port || 6379), target.hostname);
                sockets.add(upstream);
                upstream.on("error", () => undefined);
                upstream.on("close", () => sockets.delete(upstream));
                client.pipe(upstream);
                upstream.pipe(client);
            }
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;

        const topic = `integration.connect-timeout.${randomUUID()}`;
        const control = new Redis(REDIS_TEST_URL as string);
        // The adapter dials the proxy but keeps the credentials and the database of the test endpoint.
        const proxied = new URL(target);
        proxied.hostname = "127.0.0.1";
        proxied.port = String(proxyPort);
        const adapter = RedisAdapter({ url: proxied.toString(), redisOptions: { connectTimeout: 300 } });
        try {
            await adapter.connect();

            const started = Date.now();
            const error = await adapter.subscribe([topic], async (_event, ack) => ack(), { group: "G" }).then(
                () => assert.fail("subscribe() must not resolve while its connection is never ready"),
                (reason: Error) => reason,
            );
            assert.match(error.message, /RedisAdapter: connection not ready within 300 ms/);
            assert.ok(Date.now() - started < 3000);

            await adapter.publish(topic, new Uint8Array([1]));
            assert.equal(await control.xlen(`events:${topic}`), 1, "the publishing connection still works");
        } finally {
            await adapter.disconnect();
            await control.del(`events:${topic}`);
            await control.quit();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
    });
});
