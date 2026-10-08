/**
 * Upgrade from the layout that earlier versions left on the broker: one durable consumer per
 * pattern. The durables are created here directly with the names and settings the previous
 * adapter used, events are published while no subscription exists, and then the current adapter
 * subscribes with the same group. The scenarios record which backlog survives the upgrade.
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

describe("NATS adapter: upgrade from one durable consumer per pattern", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /**
     * Create the durables an earlier adapter would have created for `patterns` of `group`, publish
     * `published` while nothing is subscribed, then subscribe with the current adapter and report
     * the events delivered per subject.
     */
    async function upgrade(patterns: string[], legacyPatterns: string[], published: string[]): Promise<Record<string, number>> {
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
        const delivered = await upgrade(["user.created", "user.*", "user.>"], ["user.created", "user.*", "user.>"], ["user.created", "user.updated"]);
        assert.deepEqual(delivered, { "user.created": 1, "user.updated": 1 });
    });

    it("a broader route added later starts a new durable: the backlog of the narrower durable it replaces is not delivered", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        // Only `user.created` existed before; the service now also listens on `user.>`.
        const delivered = await upgrade(["user.created", "user.>"], ["user.created"], ["user.created"]);
        assert.deepEqual(delivered, {}, "the new `user.>` durable starts at the end of the stream, like any new route");
    });

    it("partly overlapping patterns are replaced by a new durable: the backlog of the old durables is not delivered", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const delivered = await upgrade(["a.*.c", "a.b.*"], ["a.*.c", "a.b.*"], ["a.b.c"]);
        assert.deepEqual(delivered, {}, "the widened `a.>` durable starts at the end of the stream");
    });

    it("patterns without overlap keep their durables and their backlog", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const delivered = await upgrade(["pay.created", "ship.*"], ["pay.created", "ship.*"], ["pay.created", "ship.sent"]);
        assert.deepEqual(delivered, { "pay.created": 1, "ship.sent": 1 });
    });
});
