import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Consumer } from "kafkajs";
import type { ConsumerCrashPayload } from "../../src/lifecycle.ts";
import { createTopicRecovery } from "../../src/topicRecovery.ts";

type RunConfig = Parameters<Consumer["run"]>[0];
const runConfig = { autoCommit: false } as RunConfig;

const unknownTopic = (): Error => Object.assign(new Error("This server does not host this topic-partition"), { name: "KafkaJSProtocolError", type: "UNKNOWN_TOPIC_OR_PARTITION" });
/** The shape of a crash after the client library's own retries ran out: a wrapper whose `cause` is the broker's answer. */
const retriesExceeded = (cause: Error): Error => Object.assign(new Error(cause.message, { cause }), { name: "KafkaJSNumberOfRetriesExceeded" });

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > 3_000) {
            throw new Error(`waitFor: ${label}`);
        }
        await sleep(5);
    }
}

/** Run `body` with the recovery's log lines swallowed, for tests that are not about the log. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
    const { warn, error } = console;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
        return await body();
    } finally {
        console.warn = warn;
        console.error = error;
    }
}

interface FakeConsumer {
    readonly id: number;
    readonly consumer: Consumer;
    readonly onCrash: (payload: ConsumerCrashPayload) => void;
    readonly calls: string[];
}

/** Builds the pieces a subscription gives the recovery, with consumers that record what is done to them. */
function harness(options: { discover?: boolean; known: string[]; started?: string[]; topicsOnBroker: () => string[]; wildcards?: RegExp[]; literals?: string[]; failConnects?: number; retryDelay?: number; resumeTimers?: Set<NodeJS.Timeout> }) {
    const consumers: FakeConsumer[] = [];
    const subscribed: { consumer: number; topics: readonly string[]; fromBeginning: boolean }[] = [];
    const known = new Set(options.known);
    let failConnects = options.failConnects ?? 0;
    const recovery = createTopicRecovery({
        createConsumer: (onCrash) => {
            const id = consumers.length;
            const calls: string[] = [];
            const consumer = {
                connect: async () => {
                    calls.push("connect");
                    if (failConnects > 0) {
                        failConnects--;
                        throw new Error("connect failed");
                    }
                },
                disconnect: async () => {
                    calls.push("disconnect");
                },
                subscribe: async ({ topics, fromBeginning }: { topics: string[]; fromBeginning: boolean }) => {
                    calls.push(`subscribe ${topics.join(",")} fromBeginning=${fromBeginning}`);
                },
                run: async () => {
                    calls.push("run");
                },
                stop: async () => {
                    calls.push("stop");
                },
            } as unknown as Consumer;
            consumers.push({ id, consumer, onCrash, calls });
            return consumer;
        },
        literals: options.literals ?? [],
        wildcards: options.wildcards ?? [/^orders\..+$/],
        known,
        started: new Set(options.started ?? options.known),
        fromBeginning: false,
        discover: options.discover ?? true,
        runConfig,
        resumeTimers: options.resumeTimers ?? new Set(),
        listTopics: async () => options.topicsOnBroker(),
        subscribe: async (consumer, topics, fromBeginning) => {
            subscribed.push({ consumer: consumers.findIndex((c) => c.consumer === consumer), topics, fromBeginning });
        },
        ...(options.retryDelay !== undefined && { retryDelay: options.retryDelay }),
    });
    return { recovery, consumers, subscribed, known };
}

describe("createTopicRecovery", () => {
    it("replaces a consumer that crashed on a deleted wildcard topic with one subscribed to the topics that remain", async () => {
        await quietly(async () => {
            const { recovery, consumers, subscribed, known } = harness({ known: ["orders.a", "orders.b", "payments.x"], topicsOnBroker: () => ["orders.a", "payments.x"], literals: ["audit"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: retriesExceeded(unknownTopic()), groupId: "g", restart: true });
            await waitFor(() => consumers.length === 2 && consumers[1]?.calls.includes("run") === true, "a second consumer runs");

            assert.deepEqual(consumers[0]?.calls, ["disconnect"], "the crashed consumer is disconnected, which cancels the library's own restart");
            assert.deepEqual(consumers[1]?.calls, ["connect", "run"]);
            assert.deepEqual(subscribed, [{ consumer: 1, topics: ["audit", "orders.a"], fromBeginning: false }], "the literal topic and the surviving wildcard match, not the deleted one");
            assert.deepEqual([...known].sort(), ["orders.a", "payments.x"], "the known topics are the broker's current ones");
        });
    });

    it("reads a matching topic that appeared in the meantime from its beginning", async () => {
        await quietly(async () => {
            const { recovery, consumers, known } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a", "orders.c"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            assert.ok(consumers[1]?.calls.includes("subscribe orders.c fromBeginning=true"), String(consumers[1]?.calls));
            assert.ok(known.has("orders.c"));
        });
    });

    it("keeps reading a topic that discovery found after the start from its beginning", async () => {
        await quietly(async () => {
            // orders.late was found by discovery and subscribed from its beginning; a partition of it may have no committed offset yet.
            const { recovery, consumers, subscribed } = harness({ known: ["orders.a", "orders.b", "orders.late"], started: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a", "orders.late"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            assert.deepEqual(subscribed, [{ consumer: 1, topics: ["orders.a"], fromBeginning: false }], "the topics the consumer started with keep the subscription's own position");
            assert.ok(consumers[1]?.calls.includes("subscribe orders.late fromBeginning=true"), String(consumers[1]?.calls));
        });
    });

    it("treats a topic created again under the name of a deleted one as found after the start", async () => {
        await quietly(async () => {
            let onBroker = ["orders.a"];
            const { recovery, consumers, known } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => onBroker });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");

            // orders.b is created again and discovery subscribes it from its beginning; then orders.a is deleted.
            known.add("orders.b");
            known.add("orders.c");
            onBroker = ["orders.b", "orders.c"];
            consumers[1]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[2]?.calls.includes("run") === true, "a third consumer runs");
            assert.ok(consumers[2]?.calls.includes("subscribe orders.b,orders.c fromBeginning=true"), String(consumers[2]?.calls));
        });
    });

    it("keeps the topic list fixed when discovery is off: a matching topic created since the start is not subscribed", async () => {
        await quietly(async () => {
            const { recovery, consumers, known } = harness({ discover: false, known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a", "orders.c"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            assert.deepEqual(consumers[1]?.calls, ["connect", "run"], "no subscribe call of its own for the new topic");
            assert.ok(!known.has("orders.c"), "the new topic stays unknown, so a later start of discovery would still see it as new");
            assert.deepEqual([...known], ["orders.a"]);
        });
    });

    it("drops the pending partition resumes of the consumer it replaces", async () => {
        await quietly(async () => {
            const resumeTimers = new Set<NodeJS.Timeout>([setTimeout(() => undefined, 60_000)]);
            const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"], resumeTimers });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            assert.equal(resumeTimers.size, 0);
        });
    });

    it("leaves a crash alone when the error is not about an unknown topic", async () => {
        const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"] });
        recovery.spawn();
        consumers[0]?.onCrash({ error: new Error("The coordinator is not available"), groupId: "g", restart: true });
        await sleep(50);
        assert.equal(consumers.length, 1);
        assert.deepEqual(consumers[0]?.calls, []);
    });

    it("leaves a crash alone when the broker still has every topic the subscription matched", async () => {
        const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a", "orders.b"] });
        recovery.spawn();
        consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
        await sleep(50);
        assert.equal(consumers.length, 1);
        assert.deepEqual(consumers[0]?.calls, []);
    });

    it("does not treat a deleted topic that no wildcard matches as a reason to replace the consumer", async () => {
        const { recovery, consumers } = harness({ known: ["orders.a", "payments.x"], topicsOnBroker: () => ["orders.a"] });
        recovery.spawn();
        consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
        await sleep(50);
        assert.equal(consumers.length, 1);
    });

    it("never recovers a subscription without wildcards", async () => {
        const { recovery, consumers } = harness({ known: [], wildcards: [], literals: ["orders.a"], topicsOnBroker: () => [] });
        recovery.spawn();
        consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
        await sleep(50);
        assert.equal(consumers.length, 1);
    });

    it("ignores a crash reported by a consumer it has already replaced", async () => {
        await quietly(async () => {
            const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"] });
            recovery.spawn();
            const stale = consumers[0]?.onCrash;
            stale?.({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            stale?.({ error: unknownTopic(), groupId: "g", restart: true });
            await sleep(50);
            assert.equal(consumers.length, 2, "a late crash of the old consumer does not start a third");
        });
    });

    it("tries again after a replacement failed half-way, and starts a consumer even if the deleted topic is back", async () => {
        await quietly(async () => {
            let broker = ["orders.a"];
            const { recovery, consumers, known } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => broker, failConnects: 1, retryDelay: 20 });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers.length === 2 && consumers[1]?.calls.includes("disconnect") === true, "the first replacement failed");
            assert.ok(known.has("orders.b"), "known topics are not updated by a failed replacement");

            broker = ["orders.a", "orders.b"];
            await waitFor(() => consumers.length === 3 && consumers[2]?.calls.includes("run") === true, "the retry starts a running consumer");
            assert.deepEqual(consumers[2]?.calls.slice(0, 1), ["connect"]);
            assert.deepEqual([...known].sort(), ["orders.a", "orders.b"]);
        });
    });

    it("close() waits for a recovery under way, disconnects the consumer that is current, and stops all further recovery", async () => {
        await quietly(async () => {
            const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers.length === 2, "the replacement has been created");
            await recovery.close();
            const last = consumers[consumers.length - 1];
            assert.equal(last?.id, 1);
            assert.equal(last?.calls[last.calls.length - 1], "disconnect", "the current consumer is disconnected, after the recovery under way finished");
            assert.ok(last?.calls.includes("run"), "the recovery under way was not cut short");
            const count = consumers.length;
            last?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await sleep(50);
            assert.equal(consumers.length, count, "no consumer is created after close()");
        });
    });

    it("hands discovery the current consumer, also after a replacement", async () => {
        await quietly(async () => {
            const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            await recovery.current.stop();
            assert.ok(consumers[1]?.calls.includes("stop"));
            assert.ok(!consumers[0]?.calls.includes("stop"));
        });
    });

    it("runs serialized tasks one after another", async () => {
        const { recovery } = harness({ known: [], topicsOnBroker: () => [] });
        const order: string[] = [];
        const first = recovery.serialize(async () => {
            await sleep(30);
            order.push("first");
        });
        const second = recovery.serialize(async () => {
            order.push("second");
        });
        await Promise.all([first, second]);
        assert.deepEqual(order, ["first", "second"]);
    });
});
