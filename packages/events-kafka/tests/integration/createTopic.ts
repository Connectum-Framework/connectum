import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Admin } from "kafkajs";

const READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

/** Metadata errors a broker legitimately answers with while a freshly created topic is still being published to it. */
const TRANSIENT_METADATA_ERRORS = new Set(["UNKNOWN_TOPIC_OR_PARTITION", "LEADER_NOT_AVAILABLE"]);

/**
 * Create a topic and return only once the broker answers metadata requests for it with a leader on every partition.
 *
 * `admin.createTopics({ waitForLeaders: true })` is not enough: KafkaJS follows the controller's acknowledgement
 * with one metadata request and retries it solely on `LEADER_NOT_AVAILABLE`. The controller acknowledges as soon as
 * it has committed the topic, but the broker applies that to its own metadata cache a moment later, so on a slow or
 * loaded broker the request is answered with `UNKNOWN_TOPIC_OR_PARTITION`, which KafkaJS treats as fatal. That error
 * is therefore only a "not yet" here, so the wait is done by polling and tolerating both transient errors.
 */
export async function createTopicWithLeader(admin: Admin, topic: string, partitions = 1): Promise<void> {
    const created = await admin.createTopics({ waitForLeaders: false, topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }] });
    assert.equal(created, true, `topic ${topic} was not created`);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        try {
            const { topics } = await admin.fetchTopicMetadata({ topics: [topic] });
            const [metadata] = topics;
            if (metadata !== undefined && metadata.partitions.length === partitions && metadata.partitions.every((p) => p.partitionErrorCode === 0 && p.leader >= 0)) {
                return;
            }
        } catch (error) {
            const type = (error as { type?: string }).type;
            if (type === undefined || !TRANSIENT_METADATA_ERRORS.has(type)) throw error;
        }
        assert.ok(Date.now() < deadline, `topic ${topic} had no leader on every partition within ${READY_TIMEOUT_MS}ms`);
        await sleep(POLL_INTERVAL_MS);
    }
}
