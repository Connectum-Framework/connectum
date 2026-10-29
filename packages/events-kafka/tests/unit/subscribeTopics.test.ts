/**
 * Subscribing to a topic the broker does not have yet.
 *
 * The consumer here is a fake that answers like the client library does for a missing topic; the
 * behaviour against a real broker is covered by the integration test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { subscribeToTopics } from "../../src/subscribeTopics.ts";

/** The error the client library throws for a topic the broker does not host: a protocol error with a `type`. */
const unknownTopic = (): Error => Object.assign(new Error("This server does not host this topic-partition"), { name: "KafkaJSProtocolError", type: "UNKNOWN_TOPIC_OR_PARTITION" });

/** A consumer whose subscribe() fails `failures` times with `error` and then succeeds. */
function consumerFailing(failures: number, error: () => Error = unknownTopic) {
    const calls: unknown[] = [];
    return {
        calls,
        consumer: {
            async subscribe(subscription: unknown) {
                calls.push(subscription);
                if (calls.length <= failures) {
                    throw error();
                }
            },
        },
    };
}

const fastWait = { timeoutMs: 400, pollMs: 5 };

describe("subscribeToTopics", () => {
    it("subscribes at once when the topics exist", async () => {
        const { consumer, calls } = consumerFailing(0);
        await subscribeToTopics({ consumer, topics: ["a", /^b\./], fromBeginning: true, allowAutoTopicCreation: false });
        assert.deepEqual(calls, [{ topics: ["a", /^b\./], fromBeginning: true }]);
    });

    it("asks again while the broker creates the topic when auto-creation is allowed", async () => {
        const { consumer, calls } = consumerFailing(3);
        await subscribeToTopics({ consumer, topics: ["orders.created"], fromBeginning: false, allowAutoTopicCreation: true, wait: fastWait });
        assert.equal(calls.length, 4);
    });

    it("fails at once, naming the topic and the option, when auto-creation is not allowed", async () => {
        const { consumer, calls } = consumerFailing(1);
        await assert.rejects(subscribeToTopics({ consumer, topics: ["orders.created"], fromBeginning: false, allowAutoTopicCreation: false, wait: fastWait }), (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /cannot subscribe to topic "orders\.created"/);
            assert.match(err.message, /consumerOptions\.allowAutoTopicCreation/);
            assert.equal((err.cause as { type?: string }).type, "UNKNOWN_TOPIC_OR_PARTITION");
            return true;
        });
        assert.equal(calls.length, 1, "no retry without the option");
    });

    it("gives up when the topic does not appear in time, and says the broker did not create it", async () => {
        const { consumer, calls } = consumerFailing(Number.POSITIVE_INFINITY);
        await assert.rejects(subscribeToTopics({ consumer, topics: ["a", "b", /^c\./], fromBeginning: false, allowAutoTopicCreation: true, wait: fastWait }), (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /topic "a", "b"/);
            assert.doesNotMatch(err.message, /\^c/);
            assert.match(err.message, /did not create it within 400 ms/);
            assert.match(err.message, /auto\.create\.topics\.enable/);
            return true;
        });
        assert.ok(calls.length > 2, "it kept asking until the deadline");
    });

    it("does not retry or rename any other failure", async () => {
        const boom = new Error("Connection error: refused");
        const { consumer, calls } = consumerFailing(5, () => boom);
        await assert.rejects(subscribeToTopics({ consumer, topics: ["a"], fromBeginning: false, allowAutoTopicCreation: true, wait: fastWait }), (err: unknown) => err === boom);
        assert.equal(calls.length, 1);
    });

    it("recognises the unknown-topic answer inside the client's retry wrapper", async () => {
        const wrapped = () => Object.assign(new Error("wrapped", { cause: unknownTopic() }), { name: "KafkaJSNumberOfRetriesExceeded" });
        const { consumer, calls } = consumerFailing(1, wrapped);
        await subscribeToTopics({ consumer, topics: ["a"], fromBeginning: false, allowAutoTopicCreation: true, wait: fastWait });
        assert.equal(calls.length, 2);
    });
});
