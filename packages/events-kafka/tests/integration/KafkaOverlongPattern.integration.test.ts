/**
 * A subscription refused for an over-long topic pattern must leave nothing behind on the broker or in the process.
 *
 * The pattern length is checked while the subscription is already being set up, so the consumer it created has to be
 * released on that failure: no open socket to the broker and no member of the consumer group.
 *
 *   KAFKA_TEST_URL=localhost:9092 pnpm exec exodus-test --typescript tests/integration/KafkaOverlongPattern.integration.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

const uniqueName = (prefix: string): string => `${prefix}-${randomUUID().replaceAll("-", "")}`;

/** Sockets the process holds open right now; a consumer that was connected and not released keeps its sockets here. */
const openSockets = (): number => process.getActiveResourcesInfo().filter((resource) => resource === "TCPSocketWrap").length;

describe("Kafka subscribe with an over-long topic pattern", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    it("rejects the subscription and releases the consumer: sockets are as before, the group has no members", { timeout: 60_000 }, async () => {
        const group = uniqueName("overlong-group");
        const adapter = KafkaAdapter({ brokers, clientId: uniqueName("overlong"), logLevel: "nothing" });
        const admin = new Kafka({ clientId: uniqueName("overlong-control"), brokers, logLevel: logLevel.NOTHING }).admin();

        await adapter.connect();
        await admin.connect();
        try {
            const socketsBefore = openSockets();

            await assert.rejects(adapter.subscribe(["a".repeat(257)], async () => undefined, { group }), /Topic pattern exceeds maximum length \(256\): 257/);

            // The release is awaited by subscribe() itself; the pause only lets the sockets' close events reach the loop.
            await sleep(500);
            assert.equal(openSockets(), socketsBefore, "the consumer's sockets must be closed after the refused subscription");

            const [described] = (await admin.describeGroups([group])).groups;
            assert.equal(described?.members.length ?? 0, 0, "the refused subscription must not leave a member in the group");
        } finally {
            await admin.disconnect();
            await adapter.disconnect();
        }
    });
});
