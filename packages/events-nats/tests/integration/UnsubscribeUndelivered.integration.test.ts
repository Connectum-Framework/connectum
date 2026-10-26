/**
 * A message the server has already sent to a subscription that is being closed is not left
 * waiting for `ack_wait`, against a real NATS JetStream server.
 *
 * The client forgets a closed subscription at once, while the server learns of it only when the
 * UNSUB reaches it: a message the server dispatches to the consumer's pending pull request in
 * between arrives for a subscription the client no longer knows, is dropped without a trace, and
 * stays "awaiting acknowledgement" until `ack_wait` (30 s by default) runs out. The test holds the
 * closing client's outgoing bytes in a TCP relay so that this window is open for as long as the
 * test needs, instead of hoping to hit a few milliseconds.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { createServer, connect as tcpConnect } from "node:net";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

async function until(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(10);
    }
}

/**
 * A TCP relay in front of the NATS server. While `hold` is set, bytes from the client to the
 * server are kept back (the server's bytes to the client pass), and released together when it is cleared.
 */
async function startRelay(target: URL): Promise<{ url: string; setHold: (hold: boolean) => void; close: () => Promise<void> }> {
    let hold = false;
    const kept: Array<{ to: Socket; chunk: Buffer }> = [];
    const sockets = new Set<Socket>();

    const server = createServer((client) => {
        const upstream = tcpConnect({ host: target.hostname, port: Number(target.port) });
        sockets.add(client);
        sockets.add(upstream);
        client.on("data", (chunk: Buffer) => {
            if (hold) {
                kept.push({ to: upstream, chunk });
            } else {
                upstream.write(chunk);
            }
        });
        upstream.on("data", (chunk) => client.write(chunk));
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("error", () => undefined);
        upstream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `nats://127.0.0.1:${port}`,
        setHold(next: boolean): void {
            hold = next;
            if (!hold) {
                for (const { to, chunk } of kept.splice(0)) {
                    to.write(chunk);
                }
            }
        },
        async close(): Promise<void> {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

describe("NatsAdapter subscription closed while the server still sends to it", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("hands a message that arrives during the close back to the group long before ack_wait", { timeout: 120_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const topic = `it.unsub.${id}`;
        const stream = `itunsub${id.slice(0, 12)}`;
        const group = `unsub-${id}`;

        const relay = await startRelay(new URL(servers));
        const publisher = NatsAdapter({ servers, stream });
        const first = NatsAdapter({ servers: relay.url, stream });
        const second = NatsAdapter({ servers, stream });
        const receivedByFirst: string[] = [];
        const receivedBySecond: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            await publisher.connect({ serviceName: "integration-unsub-publisher" });
            await first.connect({ serviceName: "integration-unsub-first" });
            await second.connect({ serviceName: "integration-unsub-second" });

            const subscription = await first.subscribe(
                [topic],
                async (event, ack, nack) => {
                    receivedByFirst.push(event.eventId);
                    if (receivedByFirst.length === 1) {
                        await held;
                        await ack();
                        return;
                    }
                    // A delivery that reaches a closing subscription is returned to the group, as the bus does.
                    await nack(true);
                },
                { group },
            );

            await publisher.publish(topic, new Uint8Array());
            await until(() => receivedByFirst.length === 1, "first handler start", 20_000);

            // The close is under way, but its UNSUB is held back: the server still has the
            // subscription's pull request and sends the next message to it.
            relay.setHold(true);
            const closing = subscription.unsubscribe();
            await publisher.publish(topic, new Uint8Array());
            await sleep(300);
            relay.setHold(false);
            release();
            await closing;

            await second.subscribe(
                [topic],
                async (event, ack) => {
                    receivedBySecond.push(event.eventId);
                    await ack();
                },
                { group },
            );

            // Far below the 30 s ack_wait: a delivery that waits for it is the defect.
            await until(() => receivedBySecond.length >= 1, "next consumer delivery", 8_000);
            await sleep(300);
            assert.equal(receivedBySecond.length, 1, `the next consumer must receive the message exactly once (got ${receivedBySecond.length})`);
            assert.equal(receivedByFirst.length, 2, `the closing subscription must see the message it was sent and return it (saw ${receivedByFirst.length})`);

            const connection = await connect({ servers });
            try {
                const manager = await jetstreamManager(connection);
                const info = await manager.consumers.info(stream, consumerName(group, topic));
                assert.equal(info.num_ack_pending, 0, "no message may wait for an acknowledgement");
            } finally {
                await connection.close();
            }
        } finally {
            release();
            relay.setHold(false);
            await first.disconnect().catch(() => undefined);
            await second.disconnect().catch(() => undefined);
            await publisher.disconnect().catch(() => undefined);
            await relay.close();
        }
    });
});
