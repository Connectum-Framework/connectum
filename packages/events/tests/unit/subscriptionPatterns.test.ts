import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import { assertPublishTopic, assertSubscriptionPatterns } from "../../src/subscriptionPatterns.ts";

/** A rejection is a TypeError whose message names the adapter, the offending pattern, where the empty segment is, and the rule. */
function rejection(adapter: string, pattern: string, reason: string): (error: unknown) => boolean {
    const message = `${adapter}: subscription pattern "${pattern}" has an empty segment (${reason}). Every dot-separated segment of a pattern must be non-empty.`;
    return (error) => error instanceof TypeError && error.message === message;
}

describe("assertSubscriptionPatterns", () => {
    it("rejects the empty string", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [""] }), rejection("TestAdapter", "", "the pattern is empty"));
    });

    it("rejects an empty segment between two dots", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a..b"] }), rejection("TestAdapter", "a..b", 'it contains ".."'));
    });

    it("rejects a leading dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [".a"] }), rejection("TestAdapter", ".a", 'it starts with "."'));
    });

    it("rejects a trailing dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a."] }), rejection("TestAdapter", "a.", 'it ends with "."'));
    });

    it("rejects a lone dot", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["."] }), rejection("TestAdapter", ".", 'it starts with "."'));
    });

    it("rejects an empty segment next to a wildcard", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a.*."] }), rejection("TestAdapter", "a.*.", 'it ends with "."'));
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["*..>"] }), rejection("TestAdapter", "*..>", 'it contains ".."'));
    });

    it("names the first bad pattern of a list in a TypeError", () => {
        assert.throws(
            () => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["ok.one", "bad..two", "."] }),
            rejection("TestAdapter", "bad..two", 'it contains ".."'),
        );
    });

    it("accepts literal patterns and both wildcards", () => {
        for (const pattern of ["a", "a.b", "a.b.c", "a.*", "a.>", ">", "*", "*.b", "a.*.c", "a_b.c-d"]) {
            assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [pattern] }), pattern);
        }
    });

    it("accepts a list of good patterns and an empty list", () => {
        assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a.b", "a.*", "a.>", ">"] }));
        assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: [] }));
    });
});

describe("assertSubscriptionPatterns with the kafka-topic-name rule", () => {
    function kafkaRejection(pattern: string): (error: unknown) => boolean {
        const message = `KafkaAdapter: subscription pattern "${pattern}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`;
        return (error) => error instanceof TypeError && error.message === message;
    }

    for (const pattern of ["", ".", ".."]) {
        it(`rejects ${JSON.stringify(pattern)}, a name Kafka reserves`, () => {
            assert.throws(() => assertSubscriptionPatterns({ adapter: "KafkaAdapter", patterns: [pattern], rule: "kafka-topic-name" }), kafkaRejection(pattern));
        });
    }

    it("names the first reserved name of a list", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "KafkaAdapter", patterns: ["ok.one", "..", "."], rule: "kafka-topic-name" }), kafkaRejection(".."));
    });

    it("accepts topic names with an empty segment, which Kafka allows", () => {
        for (const pattern of ["a..b", ".a", "a.", "...", "a.b", "a.*", "a.>", ">", "*", "a.*."]) {
            assert.doesNotThrow(() => assertSubscriptionPatterns({ adapter: "KafkaAdapter", patterns: [pattern], rule: "kafka-topic-name" }), pattern);
        }
    });

    it("keeps the empty-segment rule when no rule is given", () => {
        assert.throws(() => assertSubscriptionPatterns({ adapter: "TestAdapter", patterns: ["a..b"] }), rejection("TestAdapter", "a..b", 'it contains ".."'));
    });
});

describe("assertPublishTopic", () => {
    /** The message names the adapter and the topic and, unlike a subscription, calls the name a topic. */
    function topicRejection(adapter: string, topic: string, reason: string): (error: unknown) => boolean {
        const message = `${adapter}: publish topic "${topic}" has an empty segment (${reason}). Every dot-separated segment of a topic must be non-empty.`;
        return (error) => error instanceof TypeError && error.message === message;
    }

    for (const [topic, reason] of [
        ["", "the topic is empty"],
        ["a..b", 'it contains ".."'],
        [".a", 'it starts with "."'],
        ["a.", 'it ends with "."'],
        [".", 'it starts with "."'],
    ] as const) {
        it(`rejects ${JSON.stringify(topic)}`, () => {
            assert.throws(() => assertPublishTopic({ adapter: "TestAdapter", topic }), topicRejection("TestAdapter", topic, reason));
        });
    }

    it("accepts topics whose every segment has content", () => {
        for (const topic of ["a", "a.b", "a.b.c", "a_b.c-d", "trips.v1.TripCompleted"]) {
            assert.doesNotThrow(() => assertPublishTopic({ adapter: "TestAdapter", topic }), topic);
        }
    });

    it("refuses only the names Kafka reserves under the kafka-topic-name rule", () => {
        const kafkaRejection = (topic: string) => (error: unknown) =>
            error instanceof TypeError && error.message === `KafkaAdapter: publish topic "${topic}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`;
        for (const topic of ["", ".", ".."]) {
            assert.throws(() => assertPublishTopic({ adapter: "KafkaAdapter", topic, rule: "kafka-topic-name" }), kafkaRejection(topic));
        }
        for (const topic of ["a..b", ".a", "a.", "...", "a.b"]) {
            assert.doesNotThrow(() => assertPublishTopic({ adapter: "KafkaAdapter", topic, rule: "kafka-topic-name" }), topic);
        }
    });
});

describe("MemoryAdapter publishing to a topic with an empty segment", () => {
    for (const [label, topic, reason] of [
        ["the empty string", "", "the topic is empty"],
        ["an empty segment between dots", "a..b", 'it contains ".."'],
        ["a leading dot", ".a", 'it starts with "."'],
        ["a trailing dot", "a.", 'it ends with "."'],
        ["a lone dot", ".", 'it starts with "."'],
    ] as const) {
        it(`rejects ${label} and delivers nothing to a wildcard subscriber`, async () => {
            const adapter = MemoryAdapter();
            await adapter.connect();
            const received: string[] = [];
            await adapter.subscribe([">"], async (event) => {
                received.push(event.eventType);
            });

            await assert.rejects(
                adapter.publish(topic, new Uint8Array([1])),
                (error: unknown) => error instanceof TypeError && error.message === `MemoryAdapter: publish topic "${topic}" has an empty segment (${reason}). Every dot-separated segment of a topic must be non-empty.`,
            );

            // Control: the same adapter and subscriber do deliver a well-formed topic.
            await adapter.publish("a.b", new Uint8Array([1]));
            assert.deepEqual(received, ["a.b"]);
            await adapter.disconnect();
        });
    }

    it("reports a missing connection before it examines the topic, as subscribe() does", async () => {
        const adapter = MemoryAdapter();
        await assert.rejects(adapter.publish("a..b", new Uint8Array([1])), (error: unknown) => error instanceof Error && error.message === "MemoryAdapter: not connected");
    });
});

describe("MemoryAdapter subscription patterns", () => {
    for (const [label, pattern, reason] of [
        ["the empty string", "", "the pattern is empty"],
        ["an empty segment between dots", "a..b", 'it contains ".."'],
        ["a leading dot", ".a", 'it starts with "."'],
        ["a trailing dot", "a.", 'it ends with "."'],
        ["a lone dot", ".", 'it starts with "."'],
    ] as const) {
        it(`rejects ${label} and registers no subscription`, async () => {
            const adapter = MemoryAdapter();
            await adapter.connect();
            const received: string[] = [];

            await assert.rejects(
                adapter.subscribe(["a.b", pattern], async (event) => {
                    received.push(event.eventType);
                }),
                rejection("MemoryAdapter", pattern, reason),
            );

            await adapter.publish("a.b", new Uint8Array([1]));
            assert.deepEqual(received, [], "the rejected call left no subscription behind, not even for its good pattern");
            await adapter.disconnect();
        });
    }

    it("accepts literal, single-segment wildcard and tail wildcard patterns", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        const received: string[] = [];

        await adapter.subscribe(["a.b", "c.*", "d.>", ">"], async (event) => {
            received.push(event.eventType);
        });
        await adapter.publish("a.b", new Uint8Array([1]));

        assert.ok(received.includes("a.b"));
        await adapter.disconnect();
    });
});
