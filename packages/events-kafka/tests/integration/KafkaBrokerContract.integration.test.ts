/**
 * Documented Kafka adapter behaviour that only a real broker can confirm.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real single-node broker.
 * The expectations come from the `KafkaAdapterOptions` reference (`allowAutoTopicCreation`
 * defaults to false), from `PublishOptions.key` ("Kafka: partition key") and from the Kafka
 * protocol (messages with one key go to one partition; a closed consumer leaves its group), not
 * from the adapter's own output.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import type { Admin } from "kafkajs";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;
const SCENARIO_TIMEOUT_MS = 90_000;
const WAIT_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uniqueName = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf-8"));

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const start = Date.now();
    while (!(await condition())) {
        if (Date.now() - start > WAIT_TIMEOUT_MS) {
            throw new Error(`waitFor: ${label} not met within ${WAIT_TIMEOUT_MS}ms`);
        }
        await sleep(100);
    }
}

describe("Kafka adapter documented broker behaviour", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());
    const kafka = new Kafka({ clientId: "contract-control", brokers, logLevel: logLevel.ERROR });
    const admin: Admin = kafka.admin();
    const createdTopics: string[] = [];
    let adminConnected = false;

    async function ensureAdmin(): Promise<void> {
        if (!adminConnected) {
            await admin.connect();
            adminConnected = true;
        }
    }

    async function createTopic(name: string, partitions = 1): Promise<string> {
        await ensureAdmin();
        await createTopicWithLeader(admin, name, partitions);
        createdTopics.push(name);
        return name;
    }

    function newAdapter(consumerOptions?: { allowAutoTopicCreation?: boolean }) {
        return KafkaAdapter({
            brokers,
            clientId: uniqueName("contract"),
            logLevel: "error",
            consumerOptions: { fromBeginning: true, redeliveryDelay: 0, ...consumerOptions },
        });
    }

    after(async () => {
        if (!adminConnected) {
            return;
        }
        try {
            await admin.deleteTopics({ topics: createdTopics });
        } finally {
            await admin.disconnect();
        }
    });

    it("messages published with one key land in one partition", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("ct.keys"), 3);
        const adapter = newAdapter();
        await adapter.connect();
        try {
            for (let index = 0; index < 10; index += 1) {
                await adapter.publish(topic, bytes(`a-${index}`), { key: "customer-a" });
                await adapter.publish(topic, bytes(`b-${index}`), { key: "customer-b" });
            }
        } finally {
            await adapter.disconnect();
        }
        const offsets = await admin.fetchTopicOffsets(topic);
        const perPartition = offsets.map((entry) => Number(entry.offset)).filter((count) => count > 0);
        assert.equal(
            perPartition.reduce((sum, count) => sum + count, 0),
            20,
        );
        for (const count of perPartition) {
            assert.ok(count % 10 === 0, `all ten messages of a key share a partition, so every partition holds a multiple of ten (got ${perPartition.join(", ")})`);
        }
    });

    it("messages published without a key are spread over the partitions", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("ct.nokey"), 3);
        const adapter = newAdapter();
        await adapter.connect();
        try {
            for (let index = 0; index < 30; index += 1) {
                await adapter.publish(topic, bytes(`m-${index}`));
            }
        } finally {
            await adapter.disconnect();
        }
        const offsets = await admin.fetchTopicOffsets(topic);
        const perPartition = offsets.map((entry) => Number(entry.offset)).filter((count) => count > 0);
        assert.ok(perPartition.length > 1, `without a key the producer uses more than one partition (got ${perPartition.join(", ")})`);
    });

    it("a subscription to a topic that does not exist does not create it by default", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        await ensureAdmin();
        const topic = uniqueName("ct.absent");
        const adapter = newAdapter();
        await adapter.connect();
        try {
            // The client may refuse the subscription of an unknown topic; what matters is that the broker did not create it.
            const subscription = await adapter.subscribe([topic], async () => undefined, { group: uniqueName("group") }).catch(() => undefined);
            await sleep(3_000);
            await subscription?.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
        assert.ok(!(await admin.listTopics()).includes(topic), "allowAutoTopicCreation defaults to false");
    });

    it("allowAutoTopicCreation: true lets the broker create the topic on subscribe", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        await ensureAdmin();
        const topic = uniqueName("ct.created");
        createdTopics.push(topic);
        const adapter = newAdapter({ allowAutoTopicCreation: true });
        await adapter.connect();
        try {
            const subscription = await adapter.subscribe([topic], async () => undefined, { group: uniqueName("group") }).catch(() => undefined);
            await waitFor(async () => (await admin.listTopics()).includes(topic), `topic ${topic} created by the broker`);
            await subscription?.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("sessionTimeout reaches the broker: a value below the broker's minimum keeps the consumer out of its group", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        // The broker refuses to admit a member whose session timeout is below group.min.session.timeout.ms
        // (6000 ms by default), so a value of 1000 ms can only keep the consumer out of the group if the
        // adapter really hands the option to the client; the client's own default is 30000 ms.
        const topic = await createTopic(uniqueName("ct.session"));
        const group = uniqueName("group");
        const adapter = KafkaAdapter({ brokers, clientId: uniqueName("contract"), logLevel: "nothing", consumerOptions: { fromBeginning: true, redeliveryDelay: 0, sessionTimeout: 1_000 } });
        await adapter.connect();
        try {
            const outcome = await adapter.subscribe([topic], async () => undefined, { group }).then(
                (subscription) => subscription,
                (error: unknown) => error,
            );
            await sleep(5_000);
            const members = (await admin.describeGroups([group])).groups[0]?.members.length ?? 0;
            assert.equal(members, 0, "no member may be admitted with a session timeout below the broker's minimum");
            if (typeof outcome === "object" && outcome !== null && "unsubscribe" in outcome) {
                await (outcome as { unsubscribe(): Promise<void> }).unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("disconnect() closes the subscriptions that are still open: the consumer leaves its group", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const topic = await createTopic(uniqueName("ct.disconnect"));
        const group = uniqueName("group");
        const adapter = newAdapter();
        await adapter.connect();
        await adapter.subscribe([topic], async () => undefined, { group });
        const members = async () => (await admin.describeGroups([group])).groups[0]?.members.length ?? 0;
        await waitFor(async () => (await members()) === 1, "the consumer joined its group");

        await adapter.disconnect();

        await waitFor(async () => (await members()) === 0, "the consumer left its group");
    });
});
