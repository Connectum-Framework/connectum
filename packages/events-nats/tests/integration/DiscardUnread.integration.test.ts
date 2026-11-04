/**
 * Closing a message stream that no loop reads yet completes, and gives back what it received.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/DiscardUnread.integration.test.ts
 *
 * A subscription that ends while its consumer is being attached again after a stream loss has a
 * message stream and no loop. The client's `close()` settles only when the stream is read to its end,
 * so closing it directly never returned, and `unsubscribe()` and `disconnect()` waited for it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { discardUnread } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("discardUnread", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function openStream() {
        const stream = `du${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const connection = await connect({ servers });
        const manager = await jetstreamManager(connection);
        await manager.streams.add({ name: stream, subjects: [`${stream}.>`] });
        await manager.consumers.add(stream, { durable_name: "d", ack_policy: AckPolicy.Explicit });
        const consumer = await jetstream(connection).consumers.get(stream, "d");
        return { stream, connection, manager, consumer };
    }

    it("settles for a stream nobody reads, where close() alone does not", { timeout: 30_000 }, async () => {
        const { connection, consumer } = await openStream();
        try {
            const withClose = await consumer.consume();
            const closeAlone = await Promise.race([withClose.close().then(() => "settled"), sleep(2_000).then(() => "hung")]);
            assert.equal(closeAlone, "hung", "the premise: close() on an unread stream does not settle");

            const withDiscard = await consumer.consume();
            const discarded = await Promise.race([discardUnread(withDiscard).then(() => "settled"), sleep(10_000).then(() => "hung")]);
            assert.equal(discarded, "settled");
        } finally {
            await connection.close().catch(() => undefined);
        }
    });

    it("gives back a message that arrives while it closes, so the next consumer receives it", { timeout: 30_000 }, async () => {
        const { stream, connection, manager, consumer } = await openStream();
        try {
            const messages = await consumer.consume();
            await jetstream(connection).publish(`${stream}.t`, new Uint8Array([1]));
            await discardUnread(messages);

            // The message was given back with nak(): it is delivered again at once, not after ack_wait.
            const next = await (await jetstream(connection).consumers.get(stream, "d")).next({ expires: 3_000 });
            assert.ok(next, "the message was available to the next consumer");
            next.ack();
            const info = await manager.consumers.info(stream, "d");
            assert.equal(info.num_pending, 0);
        } finally {
            await connection.close().catch(() => undefined);
        }
    });
});
