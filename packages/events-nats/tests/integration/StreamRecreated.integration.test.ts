/**
 * A subscription resumes after the server lost its consumer: the JetStream stream was deleted and
 * created again, or only the consumer was deleted.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/StreamRecreated.integration.test.ts
 *
 * Deleting a stream deletes its consumers. The client keeps asking for messages of a consumer that no
 * longer exists, so a subscription that is not told to recreate the consumer stays silent for good:
 * `publish()` works again after the stream is back and the handler never runs. The adapter must
 * report the loss and attach a new consumer once the stream exists.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

/**
 * How long a subscription may stay silent after its stream is back before a test calls it lost, for
 * the case where the server gives the client no word of the loss.
 *
 * The server answers a request for messages that is waiting when the stream goes with "consumer
 * deleted", and the adapter reacts at once. It does not always: measured on nats-server 2.9.25, one
 * stream deletion in about ten left one of two consumers without the answer, and a request sent
 * after the stream is gone gets no answer at all (2.10.29 and 2.15.0 answered every one of 60
 * deletions, and answer the late request with "no responders", which the adapter handles). The
 * client then notices only after two missed idle heartbeats (15 s each for its default 30 s request
 * expiry) and its own check of the consumer. That path took 30 to 45 s in the measurements, so the
 * former bound of 40 s failed about one run in twenty. The wait ends as soon as the event arrives:
 * only a run that goes the slow way pays for the bound.
 */
const SLOW_LOSS_DETECTION_MS = 75_000;

/** Test timeout for a scenario that may wait for {@link SLOW_LOSS_DETECTION_MS} once or twice, plus its own fixed steps. */
const SLOW_LOSS_TEST_TIMEOUT_MS = 200_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(25);
    }
}

/** Run `body` with `console.error` and `console.warn` captured, restoring them afterwards (portable to Bun, which has no `mock.method`). */
async function withCapturedLogs(body: () => Promise<void>): Promise<string[]> {
    const originalError = console.error;
    const originalWarn = console.warn;
    const logs: string[] = [];
    const capture = (...args: unknown[]): void => {
        logs.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    };
    console.error = capture;
    console.warn = capture;
    try {
        await body();
    } catch (error) {
        // A failure without the adapter's own reports cannot be told apart from a lost event.
        throw new Error(`${error instanceof Error ? error.message : String(error)}; the adapter logged ${JSON.stringify(logs)}`, { cause: error });
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
    return logs;
}

describe("NATS adapter: the server loses the consumer", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /** An adapter subscribed to `patterns`, an admin connection, and the payloads the handler has seen. */
    async function open(patterns: string[]) {
        const stream = `W${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream });
        const admin = await connect({ servers });
        const manager = await jetstreamManager(admin);
        const got: string[] = [];
        await adapter.connect();
        const subscription = await adapter.subscribe(
            patterns,
            async (event, ack) => {
                got.push(Buffer.from(event.payload).toString());
                await ack();
            },
            { group: "G" },
        );
        const publish = (payload: string, topic = "w.t") => adapter.publish(topic, Buffer.from(payload));
        const recreateStream = () => manager.streams.add({ name: stream, subjects: [`${stream}.>`] });
        const close = async () => {
            await subscription.unsubscribe();
            await admin.close();
            await adapter.disconnect();
        };
        return { stream, manager, got, publish, recreateStream, subscription, close };
    }

    it("reports the loss and resumes delivery, including an event published right after the stream is back", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        let stream = "";
        const got = await (async () => {
            const logs = await withCapturedLogs(async () => {
                const env = await open(["w.t"]);
                stream = env.stream;
                try {
                    await env.publish("before");
                    await until(() => env.got.includes("before"), "the first event", 15_000);

                    await env.manager.streams.delete(env.stream);
                    await sleep(500);
                    await assert.rejects(env.publish("while-gone"), "nothing is accepted while the stream does not exist");
                    await env.recreateStream();

                    // The first event after the stream is back must not be lost to the gap before the consumer is attached again.
                    await env.publish("right-after");
                    await until(() => env.got.includes("right-after"), "an event published right after the stream was recreated", SLOW_LOSS_DETECTION_MS);

                    await env.publish("later");
                    await until(() => env.got.includes("later"), "an event published after the consumer was attached again", 15_000);
                    await sleep(500);
                    assert.deepEqual(env.got, ["before", "right-after", "later"], "each event was handled exactly once, in order");
                } finally {
                    await env.close();
                }
            });
            return logs;
        })();
        const reports = got.filter((line) => line.startsWith("[EventBus/NATS]") && line.includes(`stream "${stream}"`));
        assert.equal(reports.length, 2, `the loss and the recovery are each reported once, got ${JSON.stringify(got)}`);
        assert.match(reports[0] ?? "", /The server lost consumer .* together with its stream|The server lost consumer .* its stream is not available/);
        assert.match(reports[1] ?? "", /exists again; delivery resumes/);
    });

    it("waits for a stream that stays deleted for a while and resumes when it is back", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        const env = await open(["w.t"]);
        try {
            await withCapturedLogs(async () => {
                await env.publish("before");
                await until(() => env.got.includes("before"), "the first event", 15_000);

                await env.manager.streams.delete(env.stream);
                await sleep(3_000);
                await env.recreateStream();
                await sleep(300);
                await env.publish("after-outage");
                await until(() => env.got.includes("after-outage"), "an event published after a long outage", SLOW_LOSS_DETECTION_MS);
            });
            assert.deepEqual(env.got, ["before", "after-outage"]);
        } finally {
            await env.close();
        }
    });

    it("drops the acknowledgement of a delivery made before the loss, so it cannot settle a message of the new stream", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        const stream = `W${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const slow = NatsAdapter({ servers, stream });
        const other = NatsAdapter({ servers, stream });
        const admin = await connect({ servers });
        const manager = await jetstreamManager(admin);
        let releaseOld: () => void = () => undefined;
        const oldMayFinish = new Promise<void>((resolve) => {
            releaseOld = resolve;
        });
        let releaseNew: () => void = () => undefined;
        const newMayFail = new Promise<void>((resolve) => {
            releaseNew = resolve;
        });
        let oldHandling = false;
        const newRuns: string[] = [];
        let logs: string[] = [];
        try {
            logs = await withCapturedLogs(async () => {
                await slow.connect();
                await other.connect();
                // Only this replica subscribes first, so it receives the first event and holds it.
                await slow.subscribe(
                    ["w.t"],
                    async (event, ack) => {
                        if (Buffer.from(event.payload).toString() === "old") {
                            oldHandling = true;
                            await oldMayFinish;
                            await ack();
                        } else {
                            await ack();
                        }
                    },
                    { group: "G" },
                );
                await slow.publish("w.t", Buffer.from("old"));
                await until(() => oldHandling, "the old event reaching the slow replica", 15_000);
                await other.subscribe(
                    ["w.t"],
                    async (event, ack) => {
                        const payload = Buffer.from(event.payload).toString();
                        newRuns.push(payload);
                        if (newRuns.length === 1) {
                            await newMayFail;
                            throw new Error("fails once");
                        }
                        await ack();
                    },
                    { group: "G" },
                );

                await manager.streams.delete(stream);
                await sleep(300);
                await manager.streams.add({ name: stream, subjects: [`${stream}.>`] });

                // The first event of the new stream has the same stream sequence as the old event the slow replica still handles.
                await other.publish("w.t", Buffer.from("new"));
                await until(() => newRuns.length === 1, "the new event reaching the other replica", SLOW_LOSS_DETECTION_MS);
                releaseOld();
                await sleep(1_000);
                releaseNew();
                await until(() => newRuns.length === 2, "the new event delivered again after it failed", 15_000);
            });
            assert.deepEqual(newRuns, ["new", "new"], `logs: ${JSON.stringify(logs)}`);
        } finally {
            releaseOld();
            releaseNew();
            await admin.close();
            await other.disconnect();
            await slow.disconnect();
        }
    });

    it("recovers again when the stream is lost a second time", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        const env = await open(["w.t"]);
        try {
            await withCapturedLogs(async () => {
                for (const round of ["first", "second"]) {
                    await env.manager.streams.delete(env.stream);
                    await sleep(300);
                    await env.recreateStream();
                    await env.publish(round);
                    await until(() => env.got.includes(round), `an event after the ${round} loss`, SLOW_LOSS_DETECTION_MS);
                }
            });
            assert.deepEqual(env.got, ["first", "second"]);
        } finally {
            await env.close();
        }
    });

    it("resumes when the client asks for messages only after the stream is gone, and the server answers that nobody serves the request", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        const stream = `W${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        // With `prefetch: 1` the client asks for the next message only after the handler of the current one is done,
        // so a handler held back across the loss makes the next request reach a server that no longer has the consumer.
        // The server then answers "no responders" instead of "consumer deleted", and nothing else tells the client.
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { prefetch: 1 } });
        const admin = await connect({ servers });
        const manager = await jetstreamManager(admin);
        const got: string[] = [];
        let releaseHeld: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            releaseHeld = resolve;
        });
        let holding = false;
        try {
            await adapter.connect();
            const subscription = await adapter.subscribe(
                ["w.t"],
                async (event, ack) => {
                    const payload = Buffer.from(event.payload).toString();
                    if (payload === "held") {
                        holding = true;
                        await held;
                    }
                    got.push(payload);
                    await ack();
                },
                { group: "G" },
            );
            const logs = await withCapturedLogs(async () => {
                await adapter.publish("w.t", Buffer.from("held"));
                await until(() => holding, "the first event reaching the handler", 15_000);

                await manager.streams.delete(stream);
                await sleep(300);
                await manager.streams.add({ name: stream, subjects: [`${stream}.>`] });
                releaseHeld();
                await until(() => got.includes("held"), "the held handler finishing", 15_000);

                await adapter.publish("w.t", Buffer.from("after"));
                // NATS server 2.9 does not answer a request for messages of a consumer that is gone, so only the client's
                // heartbeat check can tell (see SLOW_LOSS_DETECTION_MS); later servers answer "no responders" at once.
                const answersAtOnce = !/^2\.9\./.test(admin.info?.version ?? "");
                await until(() => got.includes("after"), "an event after the stream was recreated", answersAtOnce ? 15_000 : SLOW_LOSS_DETECTION_MS);
            });
            assert.ok(
                logs.some((line) => line.includes(`stream "${stream}"`) && /exists again; delivery resumes/.test(line)),
                `the recovery is reported, got ${JSON.stringify(logs)}`,
            );
            await subscription.unsubscribe();
        } finally {
            releaseHeld();
            await admin.close();
            await adapter.disconnect();
        }
    });

    it("reports a consumer deleted on its own and does not create it again",{ timeout: 90_000 }, async () => {
        const env = await open(["w.t"]);
        try {
            const logs = await withCapturedLogs(async () => {
                await env.publish("one");
                await until(() => env.got.includes("one"), "the first event", 15_000);

                await env.manager.consumers.delete(env.stream, consumerName("G", "w.t"));
                await env.publish("two");
                await sleep(2_000);
            });
            const reports = logs.filter((line) => line.startsWith("[EventBus/NATS]") && line.includes(`stream "${env.stream}"`));
            assert.equal(reports.length, 1, `the deletion is reported once, got ${JSON.stringify(logs)}`);
            assert.match(reports[0] ?? "", /was deleted while its stream still exists. The adapter does not create it again/);
            assert.deepEqual(env.got, ["one"], "nothing arrives on a consumer an operator removed");
            await assert.rejects(env.manager.consumers.info(env.stream, consumerName("G", "w.t")), "the consumer is not created again behind the operator's back");
        } finally {
            await env.close();
        }
    });

    it("loses no event for overlapping patterns after the stream is recreated, and runs the handler at most twice for one", { timeout: SLOW_LOSS_TEST_TIMEOUT_MS }, async () => {
        const env = await open(["w.t", "w.>"]);
        try {
            await withCapturedLogs(async () => {
                await env.publish("before");
                await until(() => env.got.includes("before"), "the first event", 15_000);

                await env.manager.streams.delete(env.stream);
                await sleep(300);
                await env.recreateStream();
                await env.publish("after-specific", "w.t");
                await env.publish("after-wide", "w.other");
                await until(() => env.got.includes("after-specific") && env.got.includes("after-wide"), "events after the stream was recreated", SLOW_LOSS_DETECTION_MS);
                await sleep(1_000);
            });
            // While the consumers of the two patterns are created again one after the other, a delivery of one pattern
            // cannot know where the other starts and runs the handler itself: an event may run it twice, never zero times.
            const runs = (payload: string): number => env.got.filter((got) => got === payload).length;
            assert.equal(runs("before"), 1);
            for (const payload of ["after-specific", "after-wide"]) {
                assert.ok(runs(payload) >= 1 && runs(payload) <= 2, `${payload} ran the handler ${runs(payload)} times`);
            }
        } finally {
            await env.close();
        }
    });

    it("stops waiting for a missing stream when the subscription ends, and leaves no consumer behind", { timeout: 60_000 }, async () => {
        const env = await open(["w.t"]);
        let closed = false;
        try {
            await withCapturedLogs(async () => {
                await env.publish("before");
                await until(() => env.got.includes("before"), "the first event", 15_000);
                await env.manager.streams.delete(env.stream);
                await sleep(1_000);

                const started = Date.now();
                await env.subscription.unsubscribe();
                assert.ok(Date.now() - started < 10_000, "unsubscribe() did not wait for the missing stream");

                await env.recreateStream();
                await sleep(1_500);
                const consumers: string[] = [];
                for await (const consumer of env.manager.consumers.list(env.stream)) {
                    consumers.push(consumer.name);
                }
                assert.deepEqual(consumers, [], "no consumer was created after the subscription ended");
            });
        } finally {
            closed = true;
            await env.close();
        }
        assert.ok(closed);
    });
});
