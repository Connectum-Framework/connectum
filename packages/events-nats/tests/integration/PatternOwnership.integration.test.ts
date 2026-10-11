/**
 * One durable per pattern, one handler run per event: the scenarios the per-pattern design must hold
 * beyond the plain overlap cases — a backlog that only a wider pattern's consumer holds, replicas
 * whose route sets differ, a recorded start sequence shared by later subscribers, `deliverPolicy:
 * "all"`, and a subscribe() that fails half-way next to a consumer that existed before.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;
const SCENARIO_TIMEOUT_MS = 60_000;
const SETTLE_MS = 2_500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueName(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf-8"));
}

function counter() {
    const deliveries = new Map<string, number>();
    const handler = async (event: { eventType: string; payload: Uint8Array }, ack: () => Promise<void>) => {
        const key = `${event.eventType}:${Buffer.from(event.payload).toString()}`;
        deliveries.set(key, (deliveries.get(key) ?? 0) + 1);
        await ack();
    };
    return { deliveries, handler };
}

describe("NATS adapter: pattern ownership", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function legacyDurable(stream: string, group: string, pattern: string): Promise<void> {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            await manager.consumers.add(stream, {
                durable_name: consumerName(group, pattern),
                ack_policy: AckPolicy.Explicit,
                deliver_policy: DeliverPolicy.New,
                filter_subject: `${stream}.${pattern}`,
                ack_wait: 30_000_000_000,
                max_deliver: 5,
            });
        } finally {
            await connection.close();
        }
    }

    async function consumerInfo(stream: string, name: string) {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            return await manager.consumers.info(stream, name);
        } finally {
            await connection.close();
        }
    }

    async function consumerNames(stream: string): Promise<string[]> {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            const names: string[] = [];
            for await (const info of manager.consumers.list(stream)) {
                names.push(info.name);
            }
            return names.sort();
        } finally {
            await connection.close();
        }
    }

    it("a narrower route added to a service delivers the wider consumer's backlog once and new events once", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            // The service ran with `user.>` only; `user.created` arrived while it was down.
            await legacyDurable(stream, group, "user.>");
            await adapter.publish("user.created", bytes("backlog"));
            await adapter.publish("user.updated", bytes("backlog"));

            const { deliveries, handler } = counter();
            const sub = await adapter.subscribe(["user.created", "user.>"], handler, { group });
            try {
                await adapter.publish("user.created", bytes("fresh"));
                await adapter.publish("user.updated", bytes("fresh"));
                await sleep(SETTLE_MS);
                assert.deepEqual(Object.fromEntries([...deliveries].sort()), {
                    "user.created:backlog": 1,
                    "user.created:fresh": 1,
                    "user.updated:backlog": 1,
                    "user.updated:fresh": 1,
                });
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("replicas with different route sets lose nothing (duplicates are allowed, loss is not)", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const wide = NatsAdapter({ servers, stream });
        const both = NatsAdapter({ servers, stream });
        await wide.connect();
        await both.connect();
        try {
            const seenWide = counter();
            const seenBoth = counter();
            const subWide = await wide.subscribe(["user.>"], seenWide.handler, { group });
            const subBoth = await both.subscribe(["user.created", "user.>"], seenBoth.handler, { group });
            try {
                for (let i = 0; i < 30; i++) {
                    await wide.publish(i % 2 === 0 ? "user.created" : "user.updated", bytes(String(i)));
                }
                await sleep(SETTLE_MS);
                const handled = new Map<string, number>();
                for (const map of [seenWide.deliveries, seenBoth.deliveries]) {
                    for (const [k, v] of map) handled.set(k, (handled.get(k) ?? 0) + v);
                }
                const missing = [];
                for (let i = 0; i < 30; i++) {
                    const key = `${i % 2 === 0 ? "user.created" : "user.updated"}:${i}`;
                    if (!handled.has(key)) missing.push(key);
                }
                const duplicates = [...handled].filter(([, n]) => n > 1);
                console.log(`mixed route sets: wide=${[...seenWide.deliveries.values()].reduce((a, b) => a + b, 0)} both=${[...seenBoth.deliveries.values()].reduce((a, b) => a + b, 0)} duplicates=${duplicates.length}`);
                assert.deepEqual(missing, [], "every event handled at least once");
            } finally {
                await subWide.unsubscribe();
                await subBoth.unsubscribe();
            }
        } finally {
            await wide.disconnect();
            await both.disconnect();
        }
    });

    it("attaching to a consumer made by an earlier version leaves its configuration untouched, so that version can create it again on a rollback", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            await legacyDurable(stream, group, "user.created");
            const before = await consumerInfo(stream, consumerName(group, "user.created"));
            const sub = await adapter.subscribe(["user.created", "user.>"], counter().handler, { group });
            for (let i = 1; i <= 5; i++) await adapter.publish("user.created", bytes(String(i)));
            await sleep(1_000);
            await sub.unsubscribe();
            const after = await consumerInfo(stream, consumerName(group, "user.created"));
            assert.deepEqual(after.config, before.config, "the adapter reads an existing consumer and never updates it");
            // The earlier version creates the consumer again with the same configuration on every start; the
            // server accepts that only while the configuration is still equal (2.10 and later refuse otherwise).
            const legacy = await connect({ servers });
            try {
                const manager = await jetstreamManager(legacy);
                await manager.consumers.add(stream, before.config);
            } finally {
                await legacy.close();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("an unacknowledged delivery of an existing consumer is handled after a wider route is added", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        // The consumer never acknowledged anything, so its floor is 0 and the adapter's bound is computed
        // from what it delivered; the redelivery of the in-flight message lies below that bound and
        // must still run the handler, not be acknowledged away.
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const control = await connect({ servers });
        const jsm = await jetstreamManager(control);
        const js = jetstream(control);
        await jsm.streams.add({ name: stream, subjects: [`${stream}.>`] });
        const durable = consumerName(group, "user.created");
        await jsm.consumers.add(stream, {
            durable_name: durable,
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.New,
            filter_subject: `${stream}.user.created`,
            ack_wait: 2_000_000_000,
            max_deliver: 5,
        });
        await js.publish(`${stream}.user.created`, bytes("in-flight"));
        const earlier = await js.consumers.get(stream, durable);
        assert.ok(await earlier.next({ expires: 3_000 }), "the earlier version received the message and died before acknowledging");
        await js.publish(`${stream}.user.created`, bytes("pending"));
        const { deliveries, handler } = counter();
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { ackWait: 2_000 } });
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(["user.created", "user.>"], handler, { group });
            await sleep(6_000);
            await sub.unsubscribe();
            assert.equal(deliveries.get("user.created:in-flight"), 1, "the redelivered in-flight message is handled once");
            assert.equal(deliveries.get("user.created:pending"), 1, "the pending message is handled once");
        } finally {
            await adapter.disconnect();
            await jsm.streams.delete(stream).catch(() => undefined);
            await control.close();
        }
    });

    it("deliverPolicy 'all': history matched by nested patterns is delivered once per event", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { deliverPolicy: "all" } });
        await adapter.connect();
        try {
            for (let i = 0; i < 10; i++) await adapter.publish(i % 2 === 0 ? "user.created" : "user.deleted", bytes(String(i)));
            const { deliveries, handler } = counter();
            const sub = await adapter.subscribe(["user.created", "user.*", "user.>"], handler, { group: uniqueName("grp") });
            try {
                await sleep(SETTLE_MS);
                assert.equal(deliveries.size, 10);
                assert.ok([...deliveries.values()].every((n) => n === 1), JSON.stringify([...deliveries]));
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("a subscribe() that fails on a later pattern keeps the consumer that existed before", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            await legacyDurable(stream, group, "pay.created");
            await assert.rejects(adapter.subscribe(["pay.created", "bad pattern"], counter().handler, { group }));
            const kept = await consumerInfo(stream, consumerName(group, "pay.created"));
            assert.equal(kept.config.filter_subject, `${stream}.pay.created`);
            await assert.rejects(consumerInfo(stream, consumerName(group, "bad pattern")), "the consumer of the failing pattern is not left behind");
        } finally {
            await adapter.disconnect();
        }
    });

    it("a subscribe() that fails half-way removes the consumers of an auto-generated group and leaves those of a named group for the next start", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            await assert.rejects(adapter.subscribe(["ok.one", "bad pattern"], counter().handler));
            assert.deepEqual(await consumerNames(stream), [], "the consumers of an auto-generated group belong to the failed call alone");

            await assert.rejects(adapter.subscribe(["ok.one", "bad pattern"], counter().handler, { group }));
            assert.deepEqual(await consumerNames(stream), [consumerName(group, "ok.one")], "a named group's consumer may be in use by another replica");
        } finally {
            await adapter.disconnect();
        }
    });

    it("a route added in a rolling change: a replica that does not have it yet loses nothing and the replica that has it handles the events", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const older = NatsAdapter({ servers, stream });
        const newer = NatsAdapter({ servers, stream });
        await older.connect();
        await newer.connect();
        try {
            const seenOlder = counter();
            const seenNewer = counter();
            const subOlder = await older.subscribe(["a.*.c", "a.b.*"], seenOlder.handler, { group });
            const subNewer = await newer.subscribe(["a.*.c", "a.b.*", "a.q.r"], seenNewer.handler, { group });
            try {
                for (let i = 0; i < 20; i++) {
                    await older.publish("a.q.r", bytes(String(i)));
                }
                await sleep(SETTLE_MS);
                const handled = new Set([...seenOlder.deliveries.keys(), ...seenNewer.deliveries.keys()]);
                assert.equal(handled.size, 20, `events of the new route handled: ${handled.size} of 20`);
            } finally {
                await subOlder.unsubscribe();
                await subNewer.unsubscribe();
            }
        } finally {
            await older.disconnect();
            await newer.disconnect();
        }
    });

    it("a route removed later does not make a consumer left over from earlier runs replay events that were already handled", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            await legacyDurable(stream, group, "user.created");
            await legacyDurable(stream, group, "user.>");
            const first = counter();
            const running = await adapter.subscribe(["user.created", "user.>"], first.handler, { group });
            for (let i = 0; i < 50; i++) {
                await adapter.publish("user.created", bytes(String(i)));
            }
            await sleep(SETTLE_MS);
            await running.unsubscribe();
            assert.equal(first.deliveries.size, 50);

            const second = counter();
            const narrowed = await adapter.subscribe(["user.created"], second.handler, { group });
            try {
                await adapter.publish("user.created", bytes("new"));
                await sleep(SETTLE_MS);
                assert.deepEqual([...second.deliveries], [["user.created:new", 1]], "only the new event; the 50 handled ones are not replayed");
            } finally {
                await narrowed.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("a consumer deleted under a running subscription stops delivering and is not recreated", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            const { deliveries, handler } = counter();
            const sub = await adapter.subscribe(["user.created"], handler, { group });
            try {
                await adapter.publish("user.created", bytes("before"));
                await sleep(1_000);
                const connection = await connect({ servers });
                try {
                    const manager = await jetstreamManager(connection);
                    await manager.consumers.delete(stream, consumerName(group, "user.created"));
                } finally {
                    await connection.close();
                }
                await adapter.publish("user.created", bytes("after"));
                await sleep(SETTLE_MS);
                assert.deepEqual([...deliveries], [["user.created:before", 1]], "nothing arrives after the consumer was removed");
                await assert.rejects(consumerInfo(stream, consumerName(group, "user.created")), "the consumer is not recreated behind the operator's back");
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("500 events over three nested patterns, every third handler run fails once: each event handled, extra runs only from redelivery", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("own");
        const adapter = NatsAdapter({ servers, stream, consumerOptions: { ackWait: 1_000 } });
        await adapter.connect();
        try {
            const runs = new Map<string, number>();
            const failedOnce = new Set<string>();
            const sub = await adapter.subscribe(
                ["user.created", "user.*", "user.>"],
                async (event, ack, nack) => {
                    const key = Buffer.from(event.payload).toString();
                    runs.set(key, (runs.get(key) ?? 0) + 1);
                    if (Number(key) % 3 === 0 && !failedOnce.has(key)) {
                        failedOnce.add(key);
                        await nack(true);
                        return;
                    }
                    await ack();
                },
                { group: uniqueName("grp") },
            );
            try {
                for (let i = 0; i < 500; i++) {
                    await adapter.publish(["user.created", "user.updated", "user.profile.changed"][i % 3] as string, bytes(String(i)));
                }
                await sleep(6_000);
                const missing = [];
                let extra = 0;
                for (let i = 0; i < 500; i++) {
                    const n = runs.get(String(i)) ?? 0;
                    if (n === 0) missing.push(i);
                    const expected = i % 3 === 0 ? 2 : 1;
                    if (n > expected) extra += n - expected;
                }
                console.log(`500 events: missing=${missing.length} runs beyond nack-redelivery=${extra}`);
                assert.deepEqual(missing, []);
                assert.equal(extra, 0);
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });
});
