/**
 * What recovery decides when the client says a consumer is gone, against a scripted server: whether
 * the stream is the old one or a new one, whether the consumer exists, and when to give up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumerConfig, ConsumerMessages, ConsumerNotification, JetStreamManager } from "@nats-io/jetstream";
import { isConsumerLoss, nanosecondsOf, restoreLostConsumer } from "../../src/consumerRecovery.ts";

const STREAM = "orders";
const CONSUMER_CREATED = "2026-01-01T00:00:00.000Z";
const NEWER_STREAM = "2026-01-01T00:05:00.000Z";
const OLD_STREAM = "2025-12-31T00:00:00.000Z";
const NOTHING_RESTORED = { startSeq: 0, streamReplaced: false, streamCreatedAt: "" } as const;

/** The JetStream API error the client raises for a missing consumer or stream: a `code` that is the API error code. */
function apiError(code: number): Error {
    return Object.assign(new Error("not found"), { code });
}

const config = { durable_name: "g--orders--abc", ack_policy: "explicit", deliver_policy: "new", filter_subject: "orders.>", ack_wait: 30_000_000_000, max_deliver: 5 } as unknown as ConsumerConfig & { durable_name: string };

/** A message stream whose status reports one notification and ends. */
function messagesReporting(...statuses: ConsumerNotification[]): ConsumerMessages {
    return {
        status: async function* () {
            yield* statuses;
        },
    } as unknown as ConsumerMessages;
}

const LOSS: ConsumerNotification = { type: "consumer_deleted", code: 409, description: "Consumer Deleted" };

/** A server whose stream was created at `streamCreated`, whose consumer exists or not, and which records what is created. */
function serverWith(options: { streamCreated: string; consumerExists: boolean }): { jsm: JetStreamManager; created: ConsumerConfig[] } {
    const created: ConsumerConfig[] = [];
    const jsm = {
        streams: { info: async () => ({ created: options.streamCreated }) },
        consumers: {
            info: async () => {
                if (!options.consumerExists) {
                    throw apiError(10014);
                }
                return { ack_floor: { stream_seq: 7 }, delivered: { stream_seq: 9 }, config };
            },
            add: async (_stream: string, added: ConsumerConfig) => {
                created.push(added);
                return { delivered: { stream_seq: 0 } };
            },
        },
    } as unknown as JetStreamManager;
    return { jsm, created };
}

async function loggedErrors(run: () => Promise<unknown>): Promise<string[]> {
    const originalError = console.error;
    const originalWarn = console.warn;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    };
    console.warn = console.error;
    try {
        await run();
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
    return lines;
}

describe("nanosecondsOf", () => {
    it("keeps the nine fractional digits the server reports, whatever their number", () => {
        assert.equal(nanosecondsOf("1970-01-01T00:00:01.123456789Z"), 1_123_456_789n);
        assert.equal(nanosecondsOf("1970-01-01T00:00:01.5Z"), 1_500_000_000n);
        assert.equal(nanosecondsOf("1970-01-01T00:00:01Z"), 1_000_000_000n);
        assert.equal(nanosecondsOf("1970-01-01T01:00:01+01:00"), 1_000_000_000n);
    });

    it("tells apart two instants inside one millisecond, which Date.parse cannot", () => {
        const earlier = "2026-01-01T00:00:00.123100000Z";
        const later = "2026-01-01T00:00:00.123900000Z";
        assert.equal(Date.parse(earlier), Date.parse(later));
        assert.ok(nanosecondsOf(later) > nanosecondsOf(earlier));
    });

    it("reads text that is not a timestamp as the epoch", () => {
        assert.equal(nanosecondsOf("yesterday"), 0n);
    });
});

describe("isConsumerLoss", () => {
    it("recognises the three notifications that say the consumer is gone and nothing else", () => {
        assert.equal(isConsumerLoss(LOSS), true);
        assert.equal(isConsumerLoss({ type: "consumer_not_found", name: "n", stream: "s", count: 1 }), true);
        assert.equal(isConsumerLoss({ type: "stream_not_found", name: "s" }), true);
        assert.equal(isConsumerLoss({ type: "heartbeats_missed", count: 2 }), false);
        assert.equal(isConsumerLoss({ type: "no_responders", code: 503 }), false);
    });
});

describe("restoreLostConsumer", () => {
    it("creates the consumer from the first message when the stream was created after the consumer", async () => {
        const { jsm, created } = serverWith({ streamCreated: NEWER_STREAM, consumerExists: false });
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>>;
        const lines = await loggedErrors(async () => {
            restored = await restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(LOSS), new AbortController().signal);
        });
        assert.deepEqual(restored, { startSeq: 1, streamReplaced: true, streamCreatedAt: NEWER_STREAM });
        assert.equal(created.length, 1);
        assert.equal(created[0]?.deliver_policy, "all", "every message of the new stream was published after the loss");
        assert.equal(created[0]?.durable_name, config.durable_name);
        assert.equal(created[0]?.filter_subject, "orders.>");
        assert.equal(created[0]?.max_deliver, 5);
        assert.equal(lines.length, 2);
        assert.match(lines[0] ?? "", /The server lost consumer "g--orders--abc" of stream "orders" together with its stream/);
        assert.match(lines[1] ?? "", /exists again; delivery resumes/);
    });

    it("treats a stream created within the same millisecond as the consumer, but later, as a new stream", async () => {
        const { jsm, created } = serverWith({ streamCreated: "2026-01-01T00:00:00.123900000Z", consumerExists: false });
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        await loggedErrors(async () => {
            restored = await restoreLostConsumer(
                { jsm, streamName: STREAM, config, createdAt: "2026-01-01T00:00:00.123100000Z", isConnectionClosed: () => false },
                messagesReporting(LOSS),
                new AbortController().signal,
            );
        });
        assert.equal(restored.streamReplaced, true);
        assert.equal(created.length, 1);
    });

    it("does not create a consumer an operator deleted while the old stream still exists, and says so", async () => {
        const { jsm, created } = serverWith({ streamCreated: OLD_STREAM, consumerExists: false });
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        const lines = await loggedErrors(async () => {
            restored = await restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(LOSS), new AbortController().signal);
        });
        assert.equal(restored, undefined);
        assert.deepEqual(created, []);
        assert.equal(lines.length, 1);
        assert.match(lines[0] ?? "", /was deleted while its stream still exists\. The adapter does not create it again/);
    });

    it("attaches to a consumer another replica created again, without creating one", async () => {
        const { jsm, created } = serverWith({ streamCreated: OLD_STREAM, consumerExists: true });
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>>;
        await loggedErrors(async () => {
            restored = await restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(LOSS), new AbortController().signal);
        });
        assert.deepEqual(restored, { startSeq: 8, streamReplaced: false, streamCreatedAt: OLD_STREAM });
        assert.deepEqual(created, []);
    });

    it("ignores notifications that do not mean the consumer is gone", async () => {
        const { jsm, created } = serverWith({ streamCreated: NEWER_STREAM, consumerExists: false });
        const restored = await restoreLostConsumer(
            { jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false },
            messagesReporting({ type: "heartbeats_missed", count: 2 }),
            new AbortController().signal,
        );
        assert.equal(restored, undefined);
        assert.deepEqual(created, []);
    });

    const NO_RESPONDERS: ConsumerNotification = { type: "no_responders", code: 503 };

    it("treats 'no responders' as a loss when the server no longer has the stream, since no 'consumer deleted' will follow", async () => {
        const { jsm, created } = serverWith({ streamCreated: NEWER_STREAM, consumerExists: false });
        // The question asked on 'no responders' finds no stream; once the stream exists again (the lookups of the recovery) only the consumer is missing.
        let asked = 0;
        (jsm.consumers as { info: unknown }).info = async () => {
            asked += 1;
            throw apiError(asked === 1 ? 10059 : 10014);
        };
        let lost = false;
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        await loggedErrors(async () => {
            restored = await restoreLostConsumer(
                { jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false },
                messagesReporting(NO_RESPONDERS),
                new AbortController().signal,
                () => {
                    lost = true;
                },
            );
        });
        assert.equal(lost, true, "the subscription is told about the loss");
        assert.deepEqual(restored, { startSeq: 1, streamReplaced: true, streamCreatedAt: NEWER_STREAM });
        assert.equal(created.length, 1);
    });

    it("treats 'no responders' as a loss when only the consumer is missing", async () => {
        const { jsm, created } = serverWith({ streamCreated: OLD_STREAM, consumerExists: false });
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        const lines = await loggedErrors(async () => {
            restored = await restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(NO_RESPONDERS), new AbortController().signal);
        });
        assert.equal(restored, undefined);
        assert.deepEqual(created, []);
        assert.match(lines[0] ?? "", /was deleted while its stream still exists\. The adapter does not create it again/);
    });

    it("leaves a consumer that still exists alone when the client reports 'no responders'", async () => {
        const { jsm, created } = serverWith({ streamCreated: OLD_STREAM, consumerExists: true });
        let lost = false;
        const restored = await restoreLostConsumer(
            { jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false },
            messagesReporting(NO_RESPONDERS),
            new AbortController().signal,
            () => {
                lost = true;
            },
        );
        assert.equal(restored, undefined);
        assert.equal(lost, false);
        assert.deepEqual(created, []);
    });

    it("leaves the consumer alone when the server cannot answer whether it exists", async () => {
        const { jsm, created } = serverWith({ streamCreated: NEWER_STREAM, consumerExists: true });
        (jsm.consumers as { info: unknown }).info = async () => {
            throw new Error("request timed out");
        };
        let lost = false;
        const restored = await restoreLostConsumer(
            { jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false },
            messagesReporting(NO_RESPONDERS),
            new AbortController().signal,
            () => {
                lost = true;
            },
        );
        assert.equal(restored, undefined);
        assert.equal(lost, false);
        assert.deepEqual(created, []);
    });

    it("gives up, with a report, when the connection is closed for good while the stream stays unreachable", async () => {
        const jsm = {
            streams: {
                info: async () => {
                    throw new Error("connection closed");
                },
            },
        } as unknown as JetStreamManager;
        let calls = 0;
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        const lines = await loggedErrors(async () => {
            restored = await restoreLostConsumer(
                { jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => ++calls > 1 },
                messagesReporting(LOSS),
                new AbortController().signal,
            );
        });
        assert.equal(restored, undefined);
        assert.equal(lines.length, 2);
        assert.match(lines[0] ?? "", /its stream is not available/);
        assert.match(lines[1] ?? "", /The connection is closed, so consumer "g--orders--abc" of stream "orders" cannot be created again/);
    });

    it("creates no consumer when the subscription ends while the stream is being looked up", async () => {
        const controller = new AbortController();
        const created: ConsumerConfig[] = [];
        const jsm = {
            streams: {
                info: async () => {
                    controller.abort();
                    return { created: NEWER_STREAM };
                },
            },
            consumers: {
                info: async () => {
                    throw apiError(10014);
                },
                add: async (_stream: string, added: ConsumerConfig) => {
                    created.push(added);
                    return { delivered: { stream_seq: 0 } };
                },
            },
        } as unknown as JetStreamManager;
        let restored: Awaited<ReturnType<typeof restoreLostConsumer>> = NOTHING_RESTORED;
        const lines = await loggedErrors(async () => {
            restored = await restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(LOSS), controller.signal);
        });
        assert.equal(restored, undefined);
        assert.deepEqual(created, [], "a consumer created for a stopped subscription would stay on the server");
        assert.deepEqual(lines, []);
    });

    it("stops waiting for the stream when the subscription ends", async () => {
        const jsm = {
            streams: {
                info: async () => {
                    throw apiError(10059);
                },
            },
        } as unknown as JetStreamManager;
        const controller = new AbortController();
        const started = Date.now();
        const pending = restoreLostConsumer({ jsm, streamName: STREAM, config, createdAt: CONSUMER_CREATED, isConnectionClosed: () => false }, messagesReporting(LOSS), controller.signal);
        setTimeout(() => controller.abort(), 100);
        let restored: Awaited<typeof pending> = NOTHING_RESTORED;
        await loggedErrors(async () => {
            restored = await pending;
        });
        assert.equal(restored, undefined);
        assert.ok(Date.now() - started < 3_000, "the wait ended with the subscription");
    });
});
