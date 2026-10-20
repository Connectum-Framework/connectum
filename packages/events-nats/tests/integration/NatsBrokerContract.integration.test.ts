/**
 * Documented NATS adapter behaviour that only a real JetStream server can confirm.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server. The expectations come from the adapter
 * guide ("subjects are prefixed with `{stream}.` and the stream is auto-created", durable
 * consumers named `{group}--{pattern}--{hash}`, at-least-once delivery), from the
 * `NatsConsumerOptions` reference (defaults and meaning of `ackWait`, `maxDeliver`,
 * `deliverPolicy`) and from the JetStream documentation (acknowledgement kinds: ack, nak,
 * term; ack wait; max deliver), not from the adapter's own output.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { RawEvent } from "@connectum/events";
import type { JetStreamManager } from "@nats-io/jetstream";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;
const WAIT_TIMEOUT_MS = 15_000;
const NS_PER_MS = 1_000_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const start = Date.now();
    while (!(await condition())) {
        if (Date.now() - start > WAIT_TIMEOUT_MS) {
            throw new Error(`waitFor: ${label} not met within ${WAIT_TIMEOUT_MS}ms`);
        }
        await sleep(25);
    }
}

const uniqueName = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf-8"));

describe("NATS adapter documented broker behaviour", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /** Run `body` with a JetStream manager of its own connection, as an observer independent of the adapter. */
    async function withManager<T>(body: (manager: JetStreamManager) => Promise<T>): Promise<T> {
        const connection = await connect({ servers });
        try {
            return await body(await jetstreamManager(connection));
        } finally {
            await connection.close();
        }
    }

    /** Configuration and state of the only durable consumer of `stream`, as the broker reports them. */
    async function onlyConsumer(stream: string) {
        return withManager(async (manager) => {
            const infos = [];
            for await (const info of manager.consumers.list(stream)) {
                infos.push(info);
            }
            assert.equal(infos.length, 1, "exactly one durable consumer is expected");
            return infos[0] as (typeof infos)[number];
        });
    }

    describe("stream", () => {
        it("creates the stream named by `stream`, bound to the subjects `<stream>.>`", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream });
            try {
                await adapter.connect({ serviceName: "contract-stream" });
                const info = await withManager((manager) => manager.streams.info(stream));
                assert.deepEqual(info.config.subjects, [`${stream}.>`]);
            } finally {
                await adapter.disconnect();
            }
        });

        it("uses the stream `events` when none is given", async () => {
            const adapter = NatsAdapter({ servers });
            try {
                await adapter.connect({ serviceName: "contract-default-stream" });
                const info = await withManager((manager) => manager.streams.info("events"));
                assert.deepEqual(info.config.subjects, ["events.>"]);
            } finally {
                await adapter.disconnect();
            }
        });
    });

    describe("an event on its way through the broker", () => {
        it("delivers the payload, the event type without the stream prefix, the user metadata and a broker-side time", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream });
            const received: RawEvent[] = [];
            try {
                await adapter.connect({ serviceName: "contract-roundtrip" });
                const subscription = await adapter.subscribe(
                    ["orders.created"],
                    async (event, ack) => {
                        received.push(event);
                        await ack();
                    },
                    { group: "roundtrip" },
                );
                const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
                const before = Date.now();
                await adapter.publish("orders.created", payload, { metadata: { "trace-id": "trace-123", "x-event-id": "forged-by-the-publisher" } });
                const after = Date.now();
                await waitFor(() => received.length === 1, "delivery");
                await subscription.unsubscribe();

                const event = received[0] as RawEvent;
                assert.equal(event.eventType, "orders.created");
                assert.deepEqual([...event.payload], [...payload]);
                assert.equal(event.attempt, 1, "the first delivery is attempt 1");
                assert.deepEqual([...event.metadata.entries()], [["trace-id", "trace-123"]], "user metadata is delivered; the internal event identifier header is not");
                assert.match(event.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the event identifier is generated by the adapter, never taken from the publisher's metadata");
                assert.ok(event.publishedAt.getTime() >= before - 2_000 && event.publishedAt.getTime() <= after + 2_000, `publishedAt is the publish time (got ${event.publishedAt.toISOString()})`);
            } finally {
                await adapter.disconnect();
            }
        });

        it("reports the time the event was published, also when it is delivered much later", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream, consumerOptions: { deliverPolicy: "all" } });
            const deliveries: Array<{ publishedAt: number; receivedAt: number }> = [];
            try {
                await adapter.connect({ serviceName: "contract-published-at" });
                const before = Date.now();
                await adapter.publish("late.topic", bytes("early"));
                const after = Date.now();
                await sleep(800);
                const subscription = await adapter.subscribe(
                    ["late.topic"],
                    async (event, ack) => {
                        deliveries.push({ publishedAt: event.publishedAt.getTime(), receivedAt: Date.now() });
                        await ack();
                    },
                    { group: "late" },
                );
                await waitFor(() => deliveries.length === 1, "delivery");
                await subscription.unsubscribe();

                const { publishedAt, receivedAt } = deliveries[0] as (typeof deliveries)[number];
                assert.ok(publishedAt >= before - 2_000 && publishedAt <= after + 2_000, "publishedAt is the publish time");
                assert.ok(receivedAt - publishedAt >= 700, `publishedAt must predate the delivery by the wait (${receivedAt - publishedAt} ms)`);
            } finally {
                await adapter.disconnect();
            }
        });

        it("gives every publish its own event identifier", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream });
            const ids: string[] = [];
            try {
                await adapter.connect({ serviceName: "contract-event-ids" });
                const subscription = await adapter.subscribe(
                    ["ids.topic"],
                    async (event, ack) => {
                        ids.push(event.eventId);
                        await ack();
                    },
                    { group: "ids" },
                );
                await adapter.publish("ids.topic", bytes("a"));
                await adapter.publish("ids.topic", bytes("b"));
                await waitFor(() => ids.length === 2, "both deliveries");
                await subscription.unsubscribe();
                assert.notEqual(ids[0], ids[1]);
            } finally {
                await adapter.disconnect();
            }
        });
    });

    describe("durable consumer configuration", () => {
        const configurations = [
            { label: "defaults", consumerOptions: undefined, ackWaitNs: 30_000 * NS_PER_MS, maxDeliver: 5, deliverPolicy: "new" },
            { label: "custom ackWait and maxDeliver, deliverPolicy all", consumerOptions: { ackWait: 60_000, maxDeliver: 10, deliverPolicy: "all" as const }, ackWaitNs: 60_000 * NS_PER_MS, maxDeliver: 10, deliverPolicy: "all" },
            { label: "deliverPolicy last", consumerOptions: { deliverPolicy: "last" as const }, ackWaitNs: 30_000 * NS_PER_MS, maxDeliver: 5, deliverPolicy: "last_per_subject" },
            { label: "deliverPolicy new, stated explicitly", consumerOptions: { deliverPolicy: "new" as const }, ackWaitNs: 30_000 * NS_PER_MS, maxDeliver: 5, deliverPolicy: "new" },
        ];
        for (const { label, consumerOptions, ackWaitNs, maxDeliver, deliverPolicy } of configurations) {
            it(`${label}: the consumer is created with explicit acknowledgement, the stated limits and the topic as its filter`, async () => {
                const stream = uniqueName("ctr");
                const adapter = NatsAdapter({ servers, stream, ...(consumerOptions ? { consumerOptions } : {}) });
                try {
                    await adapter.connect({ serviceName: "contract-consumer-config" });
                    const subscription = await adapter.subscribe(["orders.created"], async () => undefined, { group: "billing" });
                    const info = await onlyConsumer(stream);
                    assert.equal(info.config.ack_policy, "explicit");
                    assert.equal(info.config.ack_wait, ackWaitNs);
                    assert.equal(info.config.max_deliver, maxDeliver);
                    assert.equal(info.config.deliver_policy, deliverPolicy);
                    assert.equal(info.config.filter_subject, `${stream}.orders.created`);
                    assert.match(info.config.durable_name ?? "", /^billing--orders_created--[0-9a-f]{8}$/, "durable consumers are named {group}--{pattern}--{hash}");
                    await subscription.unsubscribe();
                } finally {
                    await adapter.disconnect();
                }
            });
        }

        it("patterns that differ only in punctuation keep separate consumers", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream });
            try {
                await adapter.connect({ serviceName: "contract-consumer-names" });
                const subscription = await adapter.subscribe(["orders.created", "orders_created"], async () => undefined, { group: "billing" });
                const names = await withManager(async (manager) => {
                    const found: string[] = [];
                    for await (const info of manager.consumers.list(stream)) {
                        found.push(info.config.durable_name ?? "");
                    }
                    return found;
                });
                assert.equal(new Set(names).size, 2, `the two patterns map to the same sanitized text but must not share a consumer (got ${names.join(", ")})`);
                await subscription.unsubscribe();
            } finally {
                await adapter.disconnect();
            }
        });

        it("closing a subscription without a group removes its consumers; a named group keeps its consumer", async () => {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream });
            try {
                await adapter.connect({ serviceName: "contract-consumer-cleanup" });
                const automatic = await adapter.subscribe(["auto.topic"], async () => undefined);
                const named = await adapter.subscribe(["named.topic"], async () => undefined, { group: "kept" });
                await automatic.unsubscribe();
                await named.unsubscribe();
                const remaining = await withManager(async (manager) => {
                    const found: string[] = [];
                    for await (const info of manager.consumers.list(stream)) {
                        found.push(info.config.filter_subject ?? "");
                    }
                    return found;
                });
                assert.deepEqual(remaining, [`${stream}.named.topic`]);
            } finally {
                await adapter.disconnect();
            }
        });
    });

    describe("where a new consumer starts", () => {
        /** Publish three events before the subscription exists and one after it, and report which payloads the handler saw. */
        async function deliveredWith(deliverPolicy: "new" | "all" | "last" | undefined): Promise<string[]> {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream, ...(deliverPolicy ? { consumerOptions: { deliverPolicy } } : {}) });
            const seen: string[] = [];
            try {
                await adapter.connect({ serviceName: "contract-deliver-policy" });
                for (const payload of ["old-1", "old-2", "old-3"]) {
                    await adapter.publish("history.item", bytes(payload));
                }
                const subscription = await adapter.subscribe(
                    ["history.item"],
                    async (event, ack) => {
                        seen.push(Buffer.from(event.payload).toString());
                        await ack();
                    },
                    { group: "history" },
                );
                await adapter.publish("history.item", bytes("fresh"));
                await waitFor(() => seen.includes("fresh"), "delivery of the fresh event");
                await sleep(300);
                await subscription.unsubscribe();
                return seen;
            } finally {
                await adapter.disconnect();
            }
        }

        it("by default only events published after the consumer was created are delivered", async () => {
            assert.deepEqual(await deliveredWith(undefined), ["fresh"]);
        });

        it("deliverPolicy new delivers only events published after the consumer was created", async () => {
            assert.deepEqual(await deliveredWith("new"), ["fresh"]);
        });

        it("deliverPolicy all delivers every available event, oldest first", async () => {
            assert.deepEqual(await deliveredWith("all"), ["old-1", "old-2", "old-3", "fresh"]);
        });

        it("deliverPolicy last delivers the last existing event of the subject and then the new ones", async () => {
            assert.deepEqual(await deliveredWith("last"), ["old-3", "fresh"]);
        });

        /** Publish history on several subjects, subscribe to `patterns` with `deliverPolicy: "last"`, then publish one more event; returns the payloads the handler saw. */
        async function lastOnPatterns(patterns: string[]): Promise<string[]> {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream, consumerOptions: { deliverPolicy: "last" } });
            const seen: string[] = [];
            try {
                await adapter.connect({ serviceName: "contract-deliver-last-patterns" });
                for (const [subject, payload] of [
                    ["wild.a", "a-old"],
                    ["wild.b", "b-old"],
                    ["wild.a", "a-last"],
                ] as const) {
                    await adapter.publish(subject, bytes(payload));
                }
                const subscription = await adapter.subscribe(
                    patterns,
                    async (event, ack) => {
                        seen.push(Buffer.from(event.payload).toString());
                        await ack();
                    },
                    { group: "wild" },
                );
                await adapter.publish("wild.c", bytes("fresh"));
                await waitFor(() => seen.includes("fresh"), "delivery of the fresh event");
                await sleep(300);
                await subscription.unsubscribe();
                return [...seen].sort();
            } finally {
                await adapter.disconnect();
            }
        }

        // The NatsConsumerOptions reference: `"last"` is the last message per subject.
        it("deliverPolicy last on a wildcard delivers the last existing event of every matching subject", async () => {
            assert.deepEqual(await lastOnPatterns(["wild.*"]), ["a-last", "b-old", "fresh"]);
        });

        it("deliverPolicy last with a wildcard and a literal pattern that overlap handles every event once", async () => {
            assert.deepEqual(await lastOnPatterns(["wild.a", "wild.*"]), ["a-last", "b-old", "fresh"]);
        });
    });

    describe("acknowledgement", () => {
        /** One event delivered repeatedly to a handler that settles each delivery with `settle`; returns the deliveries with their arrival times. */
        async function deliveriesWith(options: {
            ackWait?: number;
            maxDeliver?: number;
            settle: (event: RawEvent, ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => Promise<void>;
            observeMs: number;
        }): Promise<{ stream: string; deliveries: Array<{ attempt: number; eventId: string; at: number }>; consumer: Awaited<ReturnType<typeof onlyConsumer>> }> {
            const stream = uniqueName("ctr");
            const adapter = NatsAdapter({ servers, stream, consumerOptions: { ...(options.ackWait !== undefined ? { ackWait: options.ackWait } : {}), ...(options.maxDeliver !== undefined ? { maxDeliver: options.maxDeliver } : {}) } });
            const deliveries: Array<{ attempt: number; eventId: string; at: number }> = [];
            try {
                await adapter.connect({ serviceName: "contract-ack" });
                const subscription = await adapter.subscribe(
                    ["ack.topic"],
                    async (event, ack, nack) => {
                        deliveries.push({ attempt: event.attempt, eventId: event.eventId, at: Date.now() });
                        await options.settle(event, ack, nack);
                    },
                    { group: "ack" },
                );
                await adapter.publish("ack.topic", bytes("payload"));
                await waitFor(() => deliveries.length >= 1, "first delivery");
                await sleep(options.observeMs);
                const consumer = await onlyConsumer(stream);
                await subscription.unsubscribe();
                return { stream, deliveries, consumer };
            } finally {
                await adapter.disconnect();
            }
        }

        it("ack() completes the delivery: nothing stays pending and nothing is redelivered", async () => {
            const { deliveries, consumer } = await deliveriesWith({ ackWait: 1_000, settle: (_event, ack) => ack(), observeMs: 1_800 });
            assert.equal(deliveries.length, 1, "an acknowledged event is not redelivered after the ack wait");
            assert.equal(consumer.num_ack_pending, 0);
            assert.equal(consumer.ack_floor.stream_seq, 1);
        });

        for (const [label, settle] of [
            ["nack() with no argument", (_event: RawEvent, _ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => nack()],
            ["nack(true)", (_event: RawEvent, _ack: () => Promise<void>, nack: (requeue?: boolean) => Promise<void>) => nack(true)],
            [
                "a handler that throws",
                async () => {
                    throw new Error("handler failed");
                },
            ],
        ] as const) {
            it(`${label} requests redelivery at once, long before the ack wait ends`, async () => {
                const { deliveries } = await deliveriesWith({
                    ackWait: 10_000,
                    maxDeliver: 2,
                    settle: async (event, ack, nack) => {
                        if (event.attempt === 1) {
                            await settle(event, ack, nack);
                        } else {
                            await ack();
                        }
                    },
                    observeMs: 600,
                });
                assert.equal(deliveries.length, 2, "the event is delivered a second time");
                const [first, second] = deliveries as [(typeof deliveries)[number], (typeof deliveries)[number]];
                assert.equal(second.attempt, 2, "the redelivery carries the broker's delivery count");
                assert.equal(second.eventId, first.eventId, "the redelivery is the same event");
                assert.ok(second.at - first.at < 5_000, `redelivery must not wait for the 10 s ack wait (took ${second.at - first.at} ms)`);
            });
        }

        it("nack(false) terminates the event: it is never redelivered", async () => {
            const { deliveries, consumer } = await deliveriesWith({ ackWait: 1_000, settle: (_event, _ack, nack) => nack(false), observeMs: 1_800 });
            assert.equal(deliveries.length, 1, "a rejected event is not redelivered, not even after the ack wait");
            assert.equal(consumer.num_ack_pending, 0);
        });

        it("an event left unsettled is redelivered after the ack wait, and not before", async () => {
            const { deliveries } = await deliveriesWith({ ackWait: 1_000, settle: async () => undefined, observeMs: 2_500 });
            assert.ok(deliveries.length >= 2, `an unacknowledged event comes back (deliveries: ${deliveries.length})`);
            const [first, second] = deliveries as [(typeof deliveries)[number], (typeof deliveries)[number]];
            assert.equal(second.attempt, 2);
            const waited = second.at - first.at;
            assert.ok(waited >= 900, `redelivery must wait for the 1000 ms ack wait (waited ${waited} ms)`);
            assert.ok(waited < 2_500, `redelivery happens once the ack wait is over (waited ${waited} ms)`);
        });

        it("stops redelivering after maxDeliver attempts", async () => {
            const { deliveries } = await deliveriesWith({ ackWait: 1_000, maxDeliver: 2, settle: (_event, _ack, nack) => nack(), observeMs: 2_500 });
            assert.deepEqual(
                deliveries.map((delivery) => delivery.attempt),
                [1, 2],
                "an event that is always rejected is delivered maxDeliver times and no more",
            );
        });
    });
});
