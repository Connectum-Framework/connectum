/**
 * A handler failure on NATS is retried after `consumerOptions.redeliveryDelay`, and the delivery that
 * uses up `maxDeliver` is reported.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/RedeliveryDelay.integration.test.ts
 *
 * Without a delay a handler that throws gets the message back at once, so the default `maxDeliver` of
 * 5 is gone in milliseconds and nothing says so. The tests count the handler's calls and read the
 * server's own consumer state; they do not assert the delivery counter a handler sees, which is
 * not specified across JetStream versions.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";
import type { NatsConsumerOptions } from "../../src/types.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `body` with `console.error` captured, restoring it afterwards (portable to Bun, which has no `mock.method`). */
async function withCapturedErrors<T>(body: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    };
    try {
        return { result: await body(), errors };
    } finally {
        console.error = original;
    }
}

describe("NATS adapter: redelivery after a handler failure", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /** Publish one message to a handler that always throws and return the times (ms since publish) of its calls. */
    async function callTimes(consumerOptions: NatsConsumerOptions, waitMs: number): Promise<{ times: number[]; stream: string; errors: string[] }> {
        const stream = `rd${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream, consumerOptions });
        await adapter.connect();
        const times: number[] = [];
        let started = 0;
        const { errors } = await withCapturedErrors(async () => {
            try {
                await adapter.subscribe(
                    ["rd.t"],
                    async () => {
                        times.push(Date.now() - started);
                        throw new Error("poison");
                    },
                    { group: "g" },
                );
                started = Date.now();
                await adapter.publish("rd.t", new Uint8Array(1));
                await sleep(waitMs);
            } finally {
                await adapter.disconnect();
            }
        });
        return { times, stream, errors };
    }

    it("without a delay the whole delivery budget goes within a moment (the default is unchanged)", { timeout: 60_000 }, async () => {
        const { times } = await callTimes({ maxDeliver: 3 }, 2_500);
        assert.equal(times.length, 3, `expected 3 deliveries, got ${JSON.stringify(times)}`);
        assert.ok((times[2] ?? Number.POSITIVE_INFINITY) < 900, `the third delivery came ${times[2]} ms after publish`);
    });

    it("with redeliveryDelay each failure waits the delay before the next delivery", { timeout: 60_000 }, async () => {
        const { times } = await callTimes({ maxDeliver: 3, redeliveryDelay: 1_000 }, 4_500);
        assert.equal(times.length, 3, `expected 3 deliveries, got ${JSON.stringify(times)}`);
        const [first = 0, second = 0, third = 0] = times;
        assert.ok(second - first >= 900, `the second delivery came ${second - first} ms after the first`);
        assert.ok(third - second >= 900, `the third delivery came ${third - second} ms after the second`);
    });

    it("reports the delivery that uses up maxDeliver, naming the topic, the consumer and the limit", { timeout: 60_000 }, async () => {
        const { times, errors } = await callTimes({ maxDeliver: 3 }, 2_500);
        assert.equal(times.length, 3);
        const exhausted = errors.filter((line) => line.includes("maxDeliver"));
        assert.equal(exhausted.length, 1, `expected one report, got ${JSON.stringify(errors)}`);
        const [line = ""] = exhausted;
        assert.match(line, /^\[EventBus\/NATS\] /);
        assert.ok(line.includes('"rd.t"'), `the report names the topic: ${line}`);
        assert.ok(line.includes("maxDeliver (3)"), `the report names the limit: ${line}`);
        assert.ok(line.includes(`consumer "${consumerName("g", "rd.t")}"`), `the report names the consumer: ${line}`);
    });

    /** Run a handler that settles the only delivery its consumer allows and then throws; return what the adapter logged. */
    async function loggedWhenSettledThenThrows(settle: (ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => Promise<void>): Promise<string[]> {
        const stream = `rd${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { maxDeliver: 1 } });
        await adapter.connect();
        let calls = 0;
        const { errors } = await withCapturedErrors(async () => {
            try {
                await adapter.subscribe(
                    ["rd.t"],
                    async (_event, ack, nack) => {
                        calls += 1;
                        await settle(ack, nack);
                        throw new Error("fails after settling");
                    },
                    { group: "g" },
                );
                await adapter.publish("rd.t", new Uint8Array(1));
                await sleep(1_500);
            } finally {
                await adapter.disconnect();
            }
        });
        assert.equal(calls, 1);
        return errors.filter((line) => line.includes("maxDeliver"));
    }

    it("does not report an exhausted budget for a delivery the handler acknowledged before it threw", { timeout: 60_000 }, async () => {
        assert.deepEqual(await loggedWhenSettledThenThrows((ack) => ack()), []);
    });

    it("reports an exhausted budget once for a nack(true) followed by a throw", { timeout: 60_000 }, async () => {
        const lines = await loggedWhenSettledThenThrows((_ack, nack) => nack(true));
        assert.equal(lines.length, 1, `got ${JSON.stringify(lines)}`);
    });

    it("does not report a failure that still has deliveries left", { timeout: 60_000 }, async () => {
        const { times, errors } = await callTimes({ maxDeliver: 10, redeliveryDelay: 300 }, 1_000);
        assert.ok(times.length >= 2 && times.length < 10, `got ${JSON.stringify(times)}`);
        assert.deepEqual(
            errors.filter((line) => line.includes("maxDeliver")),
            [],
        );
    });

    it("tells an unlimited consumer nothing: it never runs out", { timeout: 60_000 }, async () => {
        const { times, errors } = await callTimes({ maxDeliver: -1, redeliveryDelay: 100 }, 1_200);
        assert.ok(times.length >= 3, `got ${JSON.stringify(times)}`);
        assert.deepEqual(
            errors.filter((line) => line.includes("maxDeliver")),
            [],
        );
    });

    it("holds the pause on the server: a subscription that ended meanwhile does not shorten it for the next consumer of the group", { timeout: 60_000 }, async () => {
        const stream = `rd${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const consumerOptions = { redeliveryDelay: 1_500 };
        const first = NatsAdapter({ servers, stream, consumerOptions });
        const second = NatsAdapter({ servers, stream, consumerOptions });
        await first.connect();
        await second.connect();
        try {
            let failedAt = 0;
            const subscription = await first.subscribe(
                ["rd.t"],
                async () => {
                    failedAt = Date.now();
                    throw new Error("transient");
                },
                { group: "g" },
            );
            await first.publish("rd.t", new Uint8Array(1));
            const deadline = Date.now() + 15_000;
            while (failedAt === 0 && Date.now() < deadline) {
                await sleep(10);
            }
            assert.notEqual(failedAt, 0, "the first handler ran");
            await subscription.unsubscribe();

            let receivedAt = 0;
            await second.subscribe(
                ["rd.t"],
                async (_event, ack) => {
                    receivedAt = Date.now();
                    await ack();
                },
                { group: "g" },
            );
            const waitUntil = Date.now() + 15_000;
            while (receivedAt === 0 && Date.now() < waitUntil) {
                await sleep(10);
            }
            assert.notEqual(receivedAt, 0, "the next consumer of the group received the message");
            assert.ok(receivedAt - failedAt >= 1_300, `the message came ${receivedAt - failedAt} ms after the failure`);
        } finally {
            await second.disconnect();
            await first.disconnect();
        }
    });

    it("a message waiting out its pause does not hold back the next one, even with a buffer of one", { timeout: 60_000 }, async () => {
        const stream = `rd${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { redeliveryDelay: 3_000, prefetch: 1 } });
        await adapter.connect();
        try {
            const handledAt = new Map<string, number>();
            let published = 0;
            await adapter.subscribe(
                ["rd.t"],
                async (event, ack) => {
                    const payload = Buffer.from(event.payload).toString();
                    if (payload === "A" && !handledAt.has("A-failed")) {
                        handledAt.set("A-failed", Date.now() - published);
                        throw new Error("transient");
                    }
                    handledAt.set(payload, Date.now() - published);
                    await ack();
                },
                { group: "g" },
            );
            published = Date.now();
            await adapter.publish("rd.t", Buffer.from("A"));
            await adapter.publish("rd.t", Buffer.from("B"));
            const deadline = Date.now() + 15_000;
            while (!handledAt.has("A") && Date.now() < deadline) {
                await sleep(25);
            }
            const b = handledAt.get("B") ?? Number.POSITIVE_INFINITY;
            const a = handledAt.get("A") ?? Number.POSITIVE_INFINITY;
            assert.ok(b < 2_000, `B was handled ${b} ms after publish, while A waited out its pause`);
            assert.ok(a >= 2_800, `A came back ${a} ms after publish`);
        } finally {
            await adapter.disconnect();
        }
    });

    it("leaves the message in the stream after the budget is gone, as documented", { timeout: 60_000 }, async () => {
        const { stream } = await callTimes({ maxDeliver: 2 }, 1_500);
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            assert.equal((await manager.streams.info(stream)).state.messages, 1);
            const info = await manager.consumers.info(stream, consumerName("g", "rd.t"));
            assert.equal(info.config.max_deliver, 2);
        } finally {
            await connection.close();
        }
    });
});
