/**
 * Publish and subscribe timeouts name the topic and the stream.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/TimeoutMessages.integration.test.ts
 *
 * A 5000-character topic is not answered by the server: the client gives up after its 5 s request
 * timeout with `TimeoutError: timeout`, which names neither the topic nor the stream.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

describe("NATS adapter: timeout messages", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("publish names the stream and a shortened topic and keeps the TimeoutError", { timeout: 60_000 }, async () => {
        const stream = `to${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            const topic = "a".repeat(5_000);
            await assert.rejects(adapter.publish(topic, new Uint8Array(1)), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.name, "TimeoutError");
                assert.equal(error.message, `NatsAdapter: publish to topic "${"a".repeat(100)}... (5000 characters)" on stream "${stream}" was not acknowledged in time: timeout`);
                return true;
            });
        } finally {
            await adapter.disconnect();
        }
    });

    it("publish while the broker is unreachable names the topic and the stream", { timeout: 60_000 }, async () => {
        const stream = `to${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const target = new URL(servers);
        // A relay between the adapter and the broker that can be taken away: the client buffers the publish while it reconnects.
        const sockets = new Set<net.Socket>();
        const relay = net.createServer((client) => {
            const upstream = net.connect(Number(target.port || 4222), target.hostname === "localhost" ? "127.0.0.1" : target.hostname);
            sockets.add(client);
            sockets.add(upstream);
            client.pipe(upstream);
            upstream.pipe(client);
            client.on("error", () => undefined);
            upstream.on("error", () => undefined);
        });
        await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
        const adapter = NatsAdapter({ servers: `nats://127.0.0.1:${(relay.address() as net.AddressInfo).port}`, stream });
        await adapter.connect();
        try {
            const relayClosed = new Promise<void>((resolve) => relay.close(() => resolve()));
            for (const socket of sockets) {
                socket.destroy();
            }
            await relayClosed;
            await assert.rejects(adapter.publish("orders.created", new Uint8Array(1)), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.name, "TimeoutError");
                assert.equal(error.message, `NatsAdapter: publish to topic "orders.created" on stream "${stream}" was not acknowledged in time: timeout`);
                return true;
            });
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
    });

    it("subscribe names the stream and the patterns and keeps the TimeoutError", { timeout: 60_000 }, async () => {
        const stream = `to${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            const pattern = "a".repeat(5_000);
            await assert.rejects(
                adapter.subscribe([pattern, "ok.t"], async () => undefined, { group: "g" }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.equal(error.name, "TimeoutError");
                    assert.match(error.message, /^NatsAdapter: subscribe to topics \["a{100}\.\.\. \(5000 characters\)", "ok\.t"\] on stream "to[0-9a-f]{12}" did not complete in time: timeout$/);
                    return true;
                },
            );
        } finally {
            await adapter.disconnect();
        }
    });
});
