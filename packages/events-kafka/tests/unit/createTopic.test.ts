import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Admin } from "kafkajs";
import { createTopicWithLeader, isTransientMetadataError } from "../integration/createTopic.ts";

/** What KafkaJS throws when the retries of a retriable error run out: no `type` of its own, the original error in `cause`. */
function exhaustedRetries(innerType: string): Error {
    const inner = Object.assign(new Error(innerType), { type: innerType });
    return Object.assign(new Error("Connection error"), { name: "KafkaJSNumberOfRetriesExceeded", cause: inner });
}

function adminFailingThenReady(failures: readonly unknown[], partitions = 1): { admin: Admin; calls: () => number } {
    let calls = 0;
    const admin = {
        createTopics: async () => true,
        fetchTopicMetadata: async () => {
            const failure = failures[calls];
            calls++;
            if (failure !== undefined) throw failure;
            return { topics: [{ name: "t", partitions: Array.from({ length: partitions }, (_, partitionId) => ({ partitionErrorCode: 0, partitionId, leader: 0, replicas: [0], isr: [0] })) }] };
        },
    } as unknown as Admin;
    return { admin, calls: () => calls };
}

describe("isTransientMetadataError", () => {
    it("reads the type of a plain KafkaJS error", () => {
        assert.equal(isTransientMetadataError(Object.assign(new Error("x"), { type: "UNKNOWN_TOPIC_OR_PARTITION" })), true);
        assert.equal(isTransientMetadataError(Object.assign(new Error("x"), { type: "LEADER_NOT_AVAILABLE" })), true);
        assert.equal(isTransientMetadataError(Object.assign(new Error("x"), { type: "TOPIC_AUTHORIZATION_FAILED" })), false);
    });

    it("follows the cause of a KafkaJSNumberOfRetriesExceeded wrapper", () => {
        assert.equal(isTransientMetadataError(exhaustedRetries("LEADER_NOT_AVAILABLE")), true);
        assert.equal(isTransientMetadataError(exhaustedRetries("TOPIC_AUTHORIZATION_FAILED")), false);
    });

    it("rejects errors without a type anywhere in the chain", () => {
        assert.equal(isTransientMetadataError(new Error("plain")), false);
        assert.equal(isTransientMetadataError(undefined), false);
        assert.equal(isTransientMetadataError("LEADER_NOT_AVAILABLE"), false);
    });
});

describe("createTopicWithLeader", () => {
    it("keeps polling through a wrapped leader-unavailable error and a plain unknown-topic error", async () => {
        const { admin, calls } = adminFailingThenReady([exhaustedRetries("LEADER_NOT_AVAILABLE"), Object.assign(new Error("x"), { type: "UNKNOWN_TOPIC_OR_PARTITION" })]);
        await createTopicWithLeader(admin, "t");
        assert.equal(calls(), 3);
    });

    it("rethrows an unrelated failure at once, wrapped or not", async () => {
        const wrapped = adminFailingThenReady([exhaustedRetries("TOPIC_AUTHORIZATION_FAILED")]);
        await assert.rejects(createTopicWithLeader(wrapped.admin, "t"), /Connection error/);
        assert.equal(wrapped.calls(), 1);

        const plain = adminFailingThenReady([new Error("boom")]);
        await assert.rejects(createTopicWithLeader(plain.admin, "t"), /boom/);
        assert.equal(plain.calls(), 1);
    });
});
