/**
 * Publishing to a topic with an empty segment is refused with a TypeError that names the adapter and
 * the topic, before anything reaches the broker. Without the check NATS answered every one of these
 * with `jetstream is not enabled`, which says nothing about the topic.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

describe("NATS adapter: publishing to a topic with an empty segment", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function storedMessages(stream: string): Promise<number> {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            return (await manager.streams.info(stream)).state.messages;
        } finally {
            await connection.close();
        }
    }

    for (const [label, topic, reason] of [
        ["the empty string", "", "the topic is empty"],
        ["an empty segment between dots", "a..b", 'it contains ".."'],
        ["a leading dot", ".a", 'it starts with "."'],
        ["a trailing dot", "a.", 'it ends with "."'],
        ["a lone dot", ".", 'it starts with "."'],
    ] as const) {
        it(`rejects ${label} with a TypeError and stores nothing, while a well-formed topic is stored`, { timeout: 60_000 }, async () => {
            const stream = `pub${randomUUID().replaceAll("-", "").slice(0, 12)}`;
            const adapter = NatsAdapter({ servers, stream });
            await adapter.connect();
            try {
                await assert.rejects(
                    adapter.publish(topic, new Uint8Array([1])),
                    (error: unknown) => error instanceof TypeError && error.message === `NatsAdapter: publish topic "${topic}" has an empty segment (${reason}). Every dot-separated segment of a topic must be non-empty.`,
                );
                assert.equal(await storedMessages(stream), 0, "the refused topic left nothing in the stream");

                // Control: JetStream is enabled and the stream takes a well-formed topic, so the
                // refusal above comes from the topic and not from the server.
                await adapter.publish("a.b", new Uint8Array([1]));
                assert.equal(await storedMessages(stream), 1);
            } finally {
                await adapter.disconnect();
            }
        });
    }
});
