/**
 * Overlapping subscription patterns against a real NATS JetStream server.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm --filter @connectum/events-nats test:integration
 *
 * One published event must reach the handler once per subscription, however many
 * of the subscribed patterns match its subject. The scenarios run against both
 * the newest server and the oldest one the adapter supports: the servers differ
 * in which overlapping consumer filters they accept.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { EventAdapter } from "@connectum/events";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

const SCENARIO_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 15_000;
/** How long the scenarios keep watching for a duplicate after the expected deliveries arrived. */
const QUIET_PERIOD_MS = 1_500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > WAIT_TIMEOUT_MS) {
            throw new Error(`waitFor: ${label} not met within ${WAIT_TIMEOUT_MS}ms`);
        }
        await sleep(50);
    }
}

function uniqueName(prefix: string): string {
    return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf-8"));
}

describe("NATS adapter: overlapping subscription patterns", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    /** Counts deliveries per event type and acknowledges each one. */
    function recorder(): { readonly deliveries: Map<string, number>; readonly handler: Parameters<EventAdapter["subscribe"]>[1] } {
        const deliveries = new Map<string, number>();
        return {
            deliveries,
            handler: async (event, ack) => {
                deliveries.set(event.eventType, (deliveries.get(event.eventType) ?? 0) + 1);
                await ack();
            },
        };
    }

    /** Filter subjects of the durable consumers of `stream`, as the broker reports them. */
    async function consumerFilters(stream: string): Promise<string[]> {
        const connection = await connect({ servers });
        try {
            const manager = await jetstreamManager(connection);
            const filters: string[] = [];
            for await (const info of manager.consumers.list(stream)) {
                filters.push(info.config.filter_subject ?? "");
            }
            return filters.sort();
        } finally {
            await connection.close();
        }
    }

    function total(deliveries: Map<string, number>): number {
        let sum = 0;
        for (const n of deliveries.values()) sum += n;
        return sum;
    }

    it("delivers an event once when an exact topic, `*` and `>` all match it", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const adapter = NatsAdapter({ servers, stream });
        const { deliveries, handler } = recorder();
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(["user.created", "user.*", "user.>"], handler, { group: uniqueName("grp") });
            try {
                await adapter.publish("user.created", bytes("1"));
                await adapter.publish("user.updated", bytes("2"));
                await adapter.publish("user.profile.changed", bytes("3"));

                await waitFor(() => total(deliveries) >= 3, "three events delivered");
                await sleep(QUIET_PERIOD_MS);

                assert.deepEqual(Object.fromEntries([...deliveries].sort()), { "user.created": 1, "user.profile.changed": 1, "user.updated": 1 });
                assert.deepEqual(await consumerFilters(stream), [`${stream}.user.*`, `${stream}.user.>`, `${stream}.user.created`], "one consumer per pattern, as before");
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("delivers an event once when two patterns overlap without one containing the other", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const adapter = NatsAdapter({ servers, stream });
        const { deliveries, handler } = recorder();
        await adapter.connect();
        try {
            // `a.b.c` matches both patterns; `a.x.c` only the first; `a.b.x` only the second; `a.z.z` and `q.r.s` neither.
            // The consumer filter has to be wider than the two patterns here, so `a.z.z` reaches the adapter and must be dropped.
            const sub = await adapter.subscribe(["a.*.c", "a.b.*"], handler, { group: uniqueName("grp") });
            try {
                for (const subject of ["a.b.c", "a.x.c", "a.b.x", "a.z.z", "q.r.s"]) {
                    await adapter.publish(subject, bytes(subject));
                }

                await waitFor(() => total(deliveries) >= 3, "the three matching events delivered");
                await sleep(QUIET_PERIOD_MS);

                assert.deepEqual(Object.fromEntries([...deliveries].sort()), { "a.b.c": 1, "a.b.x": 1, "a.x.c": 1 }, "a.z.z and q.r.s match no pattern and must not reach the handler");
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("keeps one delivery per event when two replicas of a group subscribe with overlapping patterns", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const group = uniqueName("grp");
        const first = NatsAdapter({ servers, stream });
        const second = NatsAdapter({ servers, stream });
        const seenByFirst = recorder();
        const seenByRest = recorder();
        await first.connect();
        await second.connect();
        try {
            const subFirst = await first.subscribe(["order.created", "order.>"], seenByFirst.handler, { group });
            const subSecond = await second.subscribe(["order.created", "order.>"], seenByRest.handler, { group });
            try {
                for (let i = 0; i < 20; i++) {
                    await first.publish("order.created", bytes(String(i)));
                }

                await waitFor(() => total(seenByFirst.deliveries) + total(seenByRest.deliveries) >= 20, "twenty events delivered");
                await sleep(QUIET_PERIOD_MS);

                assert.equal(total(seenByFirst.deliveries) + total(seenByRest.deliveries), 20, "each event is processed by exactly one replica, exactly once");
            } finally {
                await subFirst.unsubscribe();
                await subSecond.unsubscribe();
            }
        } finally {
            await first.disconnect();
            await second.disconnect();
        }
    });

    it("resumes a named group where it stopped: events published while it was away are delivered once", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        const patterns = ["user.created", "user.*", "user.>"];
        const first = recorder();
        const second = recorder();
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(patterns, first.handler, { group });
            await adapter.publish("user.created", bytes("1"));
            await waitFor(() => total(first.deliveries) >= 1, "first event delivered");
            await sub.unsubscribe();

            await adapter.publish("user.created", bytes("2"));
            await adapter.publish("user.updated", bytes("3"));

            const resumed = await adapter.subscribe(patterns, second.handler, { group });
            try {
                await waitFor(() => total(second.deliveries) >= 2, "backlog delivered");
                await sleep(QUIET_PERIOD_MS);
                assert.deepEqual(Object.fromEntries([...first.deliveries]), { "user.created": 1 });
                assert.deepEqual(Object.fromEntries([...second.deliveries].sort()), { "user.created": 1, "user.updated": 1 });
            } finally {
                await resumed.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("evaluates a wildcard for every message: a subject first used after the subscription is delivered", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const adapter = NatsAdapter({ servers, stream });
        const { deliveries, handler } = recorder();
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(["late.*"], handler, { group: uniqueName("grp") });
            try {
                await adapter.publish("late.never.seen.before", bytes("0"));
                await adapter.publish("late.brandnew", bytes("1"));
                await waitFor(() => total(deliveries) >= 1, "event delivered");
                await sleep(QUIET_PERIOD_MS);
                assert.deepEqual(Object.fromEntries([...deliveries]), { "late.brandnew": 1 });
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("keeps the durable consumers of patterns that do not overlap, one per pattern", { timeout: SCENARIO_TIMEOUT_MS }, async () => {
        const stream = uniqueName("ovl");
        const group = uniqueName("grp");
        const adapter = NatsAdapter({ servers, stream });
        const { deliveries, handler } = recorder();
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(["pay.created", "ship.*"], handler, { group });
            try {
                await adapter.publish("pay.created", bytes("1"));
                await adapter.publish("ship.sent", bytes("2"));
                await adapter.publish("pay.refunded", bytes("3"));

                await waitFor(() => total(deliveries) >= 2, "two events delivered");
                await sleep(QUIET_PERIOD_MS);

                assert.deepEqual(Object.fromEntries([...deliveries].sort()), { "pay.created": 1, "ship.sent": 1 });
                assert.deepEqual(await consumerFilters(stream), [`${stream}.pay.created`, `${stream}.ship.*`], "patterns that overlap with nothing keep one consumer each");
            } finally {
                await sub.unsubscribe();
            }
        } finally {
            await adapter.disconnect();
        }
    });
});
