import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Consumer } from "kafkajs";
import { startTopicDiscovery } from "../../src/topicDiscovery.ts";

type RunConfig = Parameters<Consumer["run"]>[0];

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

/** A consumer that records the calls the discovery makes, in order. */
function fakeConsumer(options?: { failRunTimes?: number }): { consumer: Consumer; calls: string[] } {
    const calls: string[] = [];
    let failRun = options?.failRunTimes ?? 0;
    const consumer = {
        stop: async () => {
            calls.push("stop");
        },
        subscribe: async ({ topics, fromBeginning }: { topics: string[]; fromBeginning: boolean }) => {
            calls.push(`subscribe ${topics.join(",")} fromBeginning=${fromBeginning}`);
        },
        run: async () => {
            if (failRun > 0) {
                failRun--;
                calls.push("run failed");
                throw new Error("run failed");
            }
            calls.push("run");
        },
    } as unknown as Consumer;
    return { consumer, calls };
}

const runConfig = { autoCommit: false } as RunConfig;

describe("startTopicDiscovery", () => {
    it("leaves the consumer alone while no new matching topic appears", async () => {
        const { consumer, calls } = fakeConsumer();
        let lists = 0;
        const stop = startTopicDiscovery({
            consumer,
            wildcards: [/^orders\..+$/],
            known: new Set(["orders.a"]),
            runConfig,
            resumeTimers: new Set(),
            interval: 5,
            // `payments.a` does not match; `orders.a` is already subscribed.
            listTopics: async () => {
                lists++;
                return ["orders.a", "payments.a"];
            },
        });
        await waitFor(() => lists >= 3, "three checks");
        await stop();
        assert.deepEqual(calls, []);
    });

    it("restarts the consumer once with the new topic, reading it from the beginning, and then stays quiet", async () => {
        const { consumer, calls } = fakeConsumer();
        const known = new Set(["orders.a"]);
        let topics = ["orders.a"];
        const stop = startTopicDiscovery({ consumer, wildcards: [/^orders\..+$/], known, runConfig, resumeTimers: new Set(), interval: 5, listTopics: async () => topics });
        await sleep(30);
        topics = ["orders.a", "orders.b", "other.c"];
        await waitFor(() => calls.includes("run"), "restart");
        await sleep(40);
        await stop();
        assert.deepEqual(calls, ["stop", "subscribe orders.b fromBeginning=true", "run"]);
        assert.ok(known.has("orders.b"));
        assert.ok(!known.has("other.c"));
    });

    it("drops the pending partition resumes of the consumer it stops", async () => {
        const { consumer } = fakeConsumer();
        const resumeTimers = new Set<NodeJS.Timeout>();
        let resumed = false;
        resumeTimers.add(
            setTimeout(() => {
                resumed = true;
            }, 60),
        );
        const stop = startTopicDiscovery({ consumer, wildcards: [/^orders\..+$/], known: new Set(), runConfig, resumeTimers, interval: 5, listTopics: async () => ["orders.a"] });
        await sleep(100);
        await stop();
        assert.equal(resumed, false);
        assert.equal(resumeTimers.size, 0);
    });

    it("runs the consumer again on the next check when the restart failed half-way, without subscribing twice", async () => {
        const { consumer, calls } = fakeConsumer({ failRunTimes: 1 });
        const originalError = console.error;
        const logged: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            logged.push(args);
        };
        try {
            const stop = startTopicDiscovery({ consumer, wildcards: [/^orders\..+$/], known: new Set(), runConfig, resumeTimers: new Set(), interval: 5, listTopics: async () => ["orders.a"] });
            await waitFor(() => calls.filter((c) => c === "run").length === 1, "a successful run after the failed one");
            await sleep(30);
            await stop();
        } finally {
            console.error = originalError;
        }
        assert.deepEqual(calls, ["stop", "subscribe orders.a fromBeginning=true", "run failed", "run"]);
        assert.equal(logged.length, 1);
    });

    it("keeps checking after a failed topic listing", async () => {
        const { consumer, calls } = fakeConsumer();
        const originalError = console.error;
        console.error = () => undefined;
        let attempt = 0;
        try {
            const stop = startTopicDiscovery({
                consumer,
                wildcards: [/^orders\..+$/],
                known: new Set(),
                runConfig,
                resumeTimers: new Set(),
                interval: 5,
                listTopics: async () => {
                    attempt++;
                    if (attempt === 1) {
                        throw new Error("broker unavailable");
                    }
                    return ["orders.a"];
                },
            });
            await waitFor(() => calls.includes("run"), "restart after the listing recovered");
            await stop();
        } finally {
            console.error = originalError;
        }
        assert.deepEqual(calls, ["stop", "subscribe orders.a fromBeginning=true", "run"]);
    });

    it("stop() waits for a restart under way and prevents any further check", async () => {
        const calls: string[] = [];
        let releaseStop!: () => void;
        const stopGate = new Promise<void>((resolve) => {
            releaseStop = resolve;
        });
        const consumer = {
            stop: async () => {
                calls.push("stop");
                await stopGate;
            },
            subscribe: async () => {
                calls.push("subscribe");
            },
            run: async () => {
                calls.push("run");
            },
        } as unknown as Consumer;
        let lists = 0;
        const stopDiscovery = startTopicDiscovery({
            consumer,
            wildcards: [/^orders\..+$/],
            known: new Set(),
            runConfig,
            resumeTimers: new Set(),
            interval: 5,
            listTopics: async () => {
                lists++;
                return ["orders.a"];
            },
        });
        await waitFor(() => calls.includes("stop"), "restart started");
        let stopped = false;
        const stopping = stopDiscovery().then(() => {
            stopped = true;
        });
        await sleep(20);
        assert.equal(stopped, false, "stop() resolved while the consumer was still being restarted");
        releaseStop();
        await stopping;
        const listsAtStop = lists;
        await sleep(40);
        assert.equal(lists, listsAtStop, "a check ran after stop()");
        assert.deepEqual(calls, ["stop"], "a stopped discovery must not restart the consumer it no longer owns");
    });
});
