/**
 * Durable consumers that exist before the subscription: one per pattern, with the names and
 * settings earlier adapter versions used. They are created here directly, events are published
 * while no subscription exists, and then the adapter subscribes with the same group. Whatever
 * backlog those consumers hold is delivered once, and a pattern added later starts at the end of
 * the stream like any new route.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server; see OverlappingPatterns.integration.test.ts.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AckPolicy, DeliverPolicy, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

const SCENARIO_TIMEOUT_MS = 60_000;
const SETTLE_MS = 2_500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueName(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf-8"));
}

describe("NATS adapter: durable consumers that exist before the subscription", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /**
     * Create the durables an earlier adapter would have created for `patterns` of `group`, publish
     * `published` while nothing is subscribed, then subscribe with the current adapter and report
     * the events delivered per subject.
     */
    async function attach(patterns: string[], legacyPatterns: string[], published: string[]): Promise<Record<string, number>> {
        const stream = uniqueName("leg");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            for (const pattern of legacyPatterns) {
                await manager.consumers.add(stream, {
                    durable_name: consumerName(group, pattern),
                    ack_policy: AckPolicy.Explicit,
                    deliver_policy: DeliverPolicy.New,
                    filter_subject: `${stream}.${pattern}`,
                    ack_wait: 30_000_000_000,
                    max_deliver: 5,
                });
            }
            for (const subject of published) {
                await adapter.publish(subject, bytes(subject));
            }

            const deliveries = new Map<string, number>();
            const subscription = await adapter.subscribe(
                patterns,
                async (event, ack) => {
                    deliveries.set(event.eventType, (deliveries.get(event.eventType) ?? 0) + 1);
                    await ack();
                },
                { group },
            );
            try {
                await sleep(SETTLE_MS);
            } finally {
                await subscription.unsubscribe();
            }
            return Object.fromEntries([...deliveries].sort());
        } finally {
            await connection.close();
            await adapter.disconnect();
        }
    }

    it("a pattern that survives keeps its durable: its backlog and that of the patterns it contains is delivered once", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const delivered = await attach(["user.created", "user.*", "user.>"], ["user.created", "user.*", "user.>"], ["user.created", "user.updated"]);
        assert.deepEqual(delivered, { "user.created": 1, "user.updated": 1 });
    });

    it("a broader route added later: the narrower durable keeps delivering its backlog once, the new wider durable starts at the end", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        // Only `user.created` existed before; the service now also listens on `user.>`.
        const delivered = await attach(["user.created", "user.>"], ["user.created"], ["user.created"]);
        assert.deepEqual(delivered, { "user.created": 1 });
    });

    it("partly overlapping patterns keep both durables: the backlog is delivered once", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const delivered = await attach(["a.*.c", "a.b.*"], ["a.*.c", "a.b.*"], ["a.b.c"]);
        assert.deepEqual(delivered, { "a.b.c": 1 });
    });

    it("patterns without overlap keep their durables and their backlog", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const delivered = await attach(["pay.created", "ship.*"], ["pay.created", "ship.*"], ["pay.created", "ship.sent"]);
        assert.deepEqual(delivered, { "pay.created": 1, "ship.sent": 1 });
    });
});
