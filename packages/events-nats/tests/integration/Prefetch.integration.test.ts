/**
 * `consumerOptions.prefetch` bounds how many messages the server hands to one consumer ahead of its
 * handler.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/Prefetch.integration.test.ts
 *
 * The server's `ackWait` timer of a message starts when the message is delivered to the client's
 * buffer, not when the handler starts. The handler runs one message at a time, so with the client's
 * default buffer of 100 the later messages of a burst wait out `ackWait` unprocessed and arrive a
 * second time. The test sends a burst whose total handling time is several times `ackWait` while each
 * message alone is far inside it: with `prefetch: 1` every message must arrive exactly once.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Messages in the burst, the handler's time per message, and the ack wait: 8 x 400 ms = 3.2 s against 1.5 s. */
const BURST = 8;
const HANDLER_MS = 400;
const ACK_WAIT_MS = 1_500;

async function deliveriesOfBurst(servers: string, prefetch: number | undefined): Promise<{ distinct: number; total: number }> {
    const stream = `pf${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const adapter = NatsAdapter({ servers, stream, consumerOptions: { ackWait: ACK_WAIT_MS, ...(prefetch !== undefined && { prefetch }) } });
    await adapter.connect();
    try {
        const seen = new Map<string, number>();
        await adapter.subscribe(
            ["pf.t"],
            async (event, ack) => {
                await sleep(HANDLER_MS);
                const n = event.metadata.get("n") ?? "?";
                seen.set(n, (seen.get(n) ?? 0) + 1);
                await ack();
            },
            { group: "g" },
        );
        for (let i = 0; i < BURST; i++) {
            await adapter.publish("pf.t", new Uint8Array(1), { metadata: { n: String(i) } });
        }
        const deadline = Date.now() + 30_000;
        while (seen.size < BURST && Date.now() < deadline) {
            await sleep(25);
        }
        // A redelivery of a message that was already handled would show up within one ack wait plus a handler run.
        await sleep(ACK_WAIT_MS + 2 * HANDLER_MS);
        return { distinct: seen.size, total: [...seen.values()].reduce((sum, count) => sum + count, 0) };
    } finally {
        await adapter.disconnect();
    }
}

describe("NATS adapter: prefetch", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("with prefetch 1 a sequential handler gets each message of a slow burst exactly once", { timeout: 60_000 }, async () => {
        const result = await deliveriesOfBurst(servers, 1);
        assert.deepEqual(result, { distinct: BURST, total: BURST });
    });

    it("with the default buffer the same burst arrives more than once (the behaviour prefetch exists to avoid)", { timeout: 60_000 }, async () => {
        const result = await deliveriesOfBurst(servers, undefined);
        assert.equal(result.distinct, BURST);
        assert.ok(result.total > BURST, `expected redeliveries of buffered messages, got ${result.total} deliveries`);
    });
});
