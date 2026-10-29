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
function harness(options: { runCrash?: (consumerIndex: number) => Error | undefined; discover?: boolean; known: string[]; started?: string[]; topicsOnBroker: () => string[]; wildcards?: RegExp[]; literals?: string[]; failConnects?: number; retryDelay?: number; resumeTimers?: Set<NodeJS.Timeout> }) {
    const consumers: FakeConsumer[] = [];
    /** What the subscription reports for each crash: whether the subscription will recover. */
    const reported: { consumer: number; restart: boolean }[] = [];
    /** What the subscription answered the library's question whether to restart a crashed consumer. */
    const decisions: { consumer: number; restart: boolean }[] = [];
    const subscribed: { consumer: number; topics: readonly string[]; fromBeginning: boolean }[] = [];
    const known = new Set(options.known);
    let failConnects = options.failConnects ?? 0;
    const recovery = createTopicRecovery({
        createConsumer: (hooks) => {
            const id = consumers.length;
            /** What the client library does with a crash: asks `restartOnFailure` (for a retriable error), then emits the crash. */
            const crash = async (payload: ConsumerCrashPayload): Promise<void> => {
                const restart = payload.restart && (await hooks.restartOnFailure(payload.error));
                decisions.push({ consumer: id, restart });
                reported.push({ consumer: id, restart: hooks.onCrash({ ...payload, restart }).restart });
            };
            const onCrash = (payload: ConsumerCrashPayload): void => {
                void crash(payload);
            };
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
                    // The library does not reject run() when the start fails: it reports a crash and returns.
                    const startError = options.runCrash?.(id);
                    if (startError !== undefined) {
                        await crash({ error: startError, groupId: "g", restart: false });
                    }
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
    return { recovery, consumers, subscribed, known, reported, decisions };
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

    it("tells the library not to restart a consumer it replaces, before anything else happens to that consumer, and reports the crash as recoverable", async () => {
        await quietly(async () => {
            const { recovery, consumers, decisions, reported } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"] });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a second consumer runs");
            assert.deepEqual(decisions, [{ consumer: 0, restart: false }], "the library is told not to schedule a restart: a restart already under way would start the old consumer beside its replacement");
            assert.deepEqual(reported, [{ consumer: 0, restart: true }], "the lifecycle sees a crash that the subscription recovers from");
        });
    });

    it("leaves the restart to the library when the broker still has every topic the subscription matched", async () => {
        const { recovery, consumers, decisions, reported } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a", "orders.b"] });
        recovery.spawn();
        consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
        await waitFor(() => reported.length === 1, "the crash is reported");
        assert.deepEqual(decisions, [{ consumer: 0, restart: true }]);
        assert.deepEqual(reported, [{ consumer: 0, restart: true }]);
        assert.equal(consumers.length, 1);
    });

    it("starts a replacement even when the deleted topic is back by the time it is listed again", async () => {
        await quietly(async () => {
            let calls = 0;
            // The first listing (the library's question) shows the topic gone; the second (the replacement's own) shows it back.
            const { recovery, consumers } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => (++calls === 1 ? ["orders.a"] : ["orders.a", "orders.b"]) });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers[1]?.calls.includes("run") === true, "a replacement runs although nothing is gone any more");
        });
    });

    it("does not treat a failed start of the replacement as a recovery: known topics stay, and the start is tried again", async () => {
        await quietly(async () => {
            const authorization = Object.assign(new Error("Not authorized to access group"), { name: "KafkaJSProtocolError", type: "GROUP_AUTHORIZATION_FAILED" });
            const { recovery, consumers, known } = harness({
                known: ["orders.a", "orders.b"],
                topicsOnBroker: () => ["orders.a"],
                retryDelay: 20,
                // run() of the first replacement resolves although its start failed, like the library's.
                runCrash: (index) => (index === 1 ? authorization : undefined),
            });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers.length === 3 && consumers[2]?.calls.includes("run") === true, "the start is tried again with a third consumer");
            assert.ok(consumers[1]?.calls.includes("disconnect"), "the consumer whose start failed is disconnected, which also cancels the library's restart of it");
            assert.deepEqual([...known].sort(), ["orders.a"], "known topics are updated only after the start that worked");
        });
    });

    it("keeps known topics while the replacement's start keeps failing", async () => {
        await quietly(async () => {
            const authorization = Object.assign(new Error("Not authorized to access group"), { type: "GROUP_AUTHORIZATION_FAILED" });
            const { recovery, consumers, known } = harness({ known: ["orders.a", "orders.b"], topicsOnBroker: () => ["orders.a"], retryDelay: 20, runCrash: () => authorization });
            recovery.spawn();
            consumers[0]?.onCrash({ error: unknownTopic(), groupId: "g", restart: true });
            await waitFor(() => consumers.length >= 3, "the start is tried more than once");
            assert.ok(known.has("orders.b"), "a start that failed never counts as a recovery");
            await recovery.close();
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
