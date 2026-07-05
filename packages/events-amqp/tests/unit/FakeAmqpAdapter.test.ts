/**
 * Tests for the programmable AMQP test double (#203,
 * `@connectum/events-amqp/testing`).
 *
 * The fake's contract is PARITY with the real adapter's observable surfaces:
 * the canonical lifecycle union (via the real `dispatchLifecycle` — shim and
 * isolation come along by construction), the typed error taxonomy, and the
 * probe-then-recover `connect()` semantics.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { AmqpConnectionError, AmqpPublishNackError, AmqpTopologyError } from "../../src/errors.ts";
import { FakeAmqpAdapter } from "../../src/testing.ts";
import type { AmqpLifecycleEvent } from "../../src/types.ts";

describe("FakeAmqpAdapter lifecycle parity", () => {
    it("connect → drop → recover replays the canonical union sequence with correct reconnected flags", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const flat: string[] = [];
        const fake = FakeAmqpAdapter({
            lifecycle: {
                onLifecycle: (event) => events.push(event),
                onConnected: () => flat.push("connected"),
                onDisconnected: () => flat.push("disconnected"),
            },
        });

        await fake.connect();
        fake.control.dropConnection(new Error("dropped"));
        fake.control.completeRecovery();

        assert.deepEqual(
            events.map((e) => e.type),
            ["connected", "disconnected", "reconnecting", "connected"],
        );
        assert.deepEqual(
            events.filter((e) => e.type === "connected"),
            [
                { type: "connected", reconnected: false },
                { type: "connected", reconnected: true },
            ],
        );
        // The flat shim fires too — the fake routes through the REAL dispatch.
        assert.deepEqual(flat, ["connected", "disconnected", "connected"]);
    });

    it("failSetup + failFastOnInitialSetupError: connect() rejects typed after setup-failed{initial:true} (probe parity)", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({
            failFastOnInitialSetupError: true,
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        fake.control.failSetup(undefined, { kind: "queue", name: "orders.q" });

        await assert.rejects(
            () => fake.connect(),
            (err: unknown) => {
                assert.ok(err instanceof AmqpTopologyError);
                assert.deepEqual(err.object, { kind: "queue", name: "orders.q" });
                return true;
            },
        );
        assert.deepEqual(
            events.map((e) => e.type),
            ["setup-failed"],
        );
        assert.deepEqual(events[0], { type: "setup-failed", initial: true, attempt: 0, error: (events[0] as { error: Error }).error });
    });

    it("failSetup WITHOUT fail-fast: reported and connects anyway (documented divergence)", async () => {
        const events: string[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event.type) } });
        fake.control.failSetup();

        await fake.connect();
        assert.deepEqual(events, ["setup-failed", "connected"]);
    });

    it("re-assert failure during recovery: setup-failed{initial:false, attempt} then the next reconnecting", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        fake.control.dropConnection();
        fake.control.failSetup();
        fake.control.completeRecovery(); // consumes the failure, stays recovering
        fake.control.completeRecovery(); // heals

        const types = events.map((e) => e.type);
        assert.deepEqual(types, ["connected", "disconnected", "reconnecting", "setup-failed", "reconnecting", "connected"]);
        const setupFailed = events.find((e) => e.type === "setup-failed") as { initial: boolean; attempt: number };
        assert.equal(setupFailed.initial, false);
        assert.equal(setupFailed.attempt, 1);
        const reconnects = events.filter((e) => e.type === "reconnecting") as Array<{ attempt: number }>;
        assert.deepEqual(
            reconnects.map((r) => r.attempt),
            [1, 2],
            "attempt numbering is 1-based and consecutive",
        );
    });

    it("exhaustRecovery: terminal reconnect-failed; the dead adapter fails publishes fast (message parity)", async () => {
        const events: string[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event.type) } });
        await fake.connect();
        fake.control.dropConnection();
        fake.control.exhaustRecovery();

        assert.deepEqual(events, ["connected", "disconnected", "reconnecting", "reconnect-failed"]);
        await assert.rejects(
            () => fake.publish("t", new Uint8Array([1])),
            (err: unknown) => err instanceof AmqpConnectionError && /not connected \(or recovery in progress\)/.test((err as Error).message),
        );
    });

    it("blocked/unblocked surface as union-only events", async () => {
        const union: string[] = [];
        let flatFired = 0;
        const fake = FakeAmqpAdapter({
            lifecycle: {
                onLifecycle: (event) => union.push(event.type),
                onConnected: () => {
                    flatFired += 1;
                },
            },
        });
        await fake.connect();
        fake.control.block("disk alarm");
        fake.control.unblock();

        assert.deepEqual(union, ["connected", "blocked", "unblocked"]);
        assert.equal(flatFired, 1, "flat callbacks see only their own events");
    });
});

describe("FakeAmqpAdapter state machine parity", () => {
    it("double connect() throws 'already connected'; RECOVERING and DEAD also refuse (real: connection stays non-null)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        await assert.rejects(() => fake.connect(), /already connected/);

        fake.control.dropConnection();
        await assert.rejects(() => fake.connect(), /already connected/, "connect() during recovery mirrors the real non-null connection");

        fake.control.exhaustRecovery();
        await assert.rejects(() => fake.connect(), /already connected/, "a plain retries-exhausted adapter requires disconnect() first");

        await fake.disconnect();
        await fake.connect(); // CLOSED → fresh connect works, like the real adapter
    });

    it("a mid-recovery subscribe PARKS and completes with the recovery (real waiter-queue parity)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();

        const got: string[] = [];
        const parked = fake.subscribe(["evt"], async (event) => {
            got.push(event.eventType);
        });
        let settled = false;
        parked.then(() => {
            settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false, "the subscribe is parked while recovering");

        fake.control.completeRecovery();
        await parked;
        await fake.control.deliver("evt", new Uint8Array());
        assert.deepEqual(got, ["evt"], "the parked subscription became active with the recovery");
    });

    it("a parked subscribe rejects typed when recovery exhausts (real startConsumer remap parity)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();

        const parked = fake.subscribe(["evt"], async () => undefined);
        fake.control.exhaustRecovery();

        await assert.rejects(
            () => parked,
            (err: unknown) => err instanceof AmqpConnectionError && /establishing consumer channel/.test((err as Error).message),
        );
    });

    it("unsubscribe() deactivates; disconnect() clears; exhaustRecovery() kills consumers", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        const got: string[] = [];
        const sub = await fake.subscribe(["evt"], async () => {
            got.push("hit");
        });
        await sub.unsubscribe();
        const afterUnsub = await fake.control.deliver("evt", new Uint8Array());
        assert.equal(afterUnsub.delivered, 0, "an unsubscribed handler is not invoked");

        await fake.subscribe(["evt"], async () => {
            got.push("hit2");
        });
        fake.control.dropConnection();
        fake.control.exhaustRecovery();
        await fake.disconnect();
        await fake.connect();
        const afterDeath = await fake.control.deliver("evt", new Uint8Array());
        assert.equal(afterDeath.delivered, 0, "subscriptions do not survive a dead cycle (the real fatal/exhausted teardown)");
    });

    it("deliver() requires the connected state (a real broker cannot deliver into a drop window)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();
        await assert.rejects(() => fake.control.deliver("evt", new Uint8Array()), /'recovering', not 'connected'/);
    });

    it("non-topology failSetup follows the real gating: no setup-failed event anywhere", async () => {
        const events: string[] = [];
        const fake = FakeAmqpAdapter({ failFastOnInitialSetupError: true, lifecycle: { onLifecycle: (event) => events.push(event.type) } });

        fake.control.failSetup(new Error("ECONNRESET mid-setup"));
        await fake.connect(); // consumed silently, no fail-fast (transient class)
        assert.deepEqual(events, ["connected"], "a non-topology startup failure emits no setup-failed and does not fail fast");

        fake.control.dropConnection();
        fake.control.failSetup(new Error("ECONNRESET again"));
        fake.control.completeRecovery();
        assert.deepEqual(
            events.filter((e) => e === "setup-failed"),
            [],
            "a non-topology re-assert failure schedules the next attempt without setup-failed",
        );
        assert.equal(events.filter((e) => e === "reconnecting").length, 2, "the failed re-assert scheduled another attempt");
    });
});

describe("FakeAmqpAdapter delivery settlement", () => {
    it("records ack/nack/requeue/failed; handler rejections are swallowed (real consumer parity)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        await fake.subscribe(["evt"], async (_e, ack) => ack(), { group: "acker" });
        await fake.subscribe(["evt"], async (_e, _ack, nack) => nack(false), { group: "nacker" });
        await fake.subscribe(["evt"], async (_e, _ack, nack) => nack(true), { group: "requeuer" });
        await fake.subscribe(["evt"], async () => {
            throw new Error("handler bug");
        }, { group: "thrower" });

        const result = await fake.control.deliver("evt", new Uint8Array());
        assert.deepEqual(result, { delivered: 4, acked: 1, nacked: 1, requeued: 1, failed: 1 });
    });

    it("strips internal envelope headers and honors x-published-at (real consumer parity)", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        let seen: { eventId: string; publishedAt: string; keys: string[] } | null = null;
        await fake.subscribe(["evt"], async (event) => {
            seen = { eventId: event.eventId, publishedAt: event.publishedAt.toISOString(), keys: [...event.metadata.keys()] };
        });
        await fake.control.deliver("evt", new Uint8Array(), {
            metadata: {
                "x-event-id": "fixed-id",
                "x-published-at": "2026-01-02T03:04:05.000Z",
                "x-connectum-publish-id": "corr",
                k: "v",
            },
        });

        assert.deepEqual(seen, { eventId: "fixed-id", publishedAt: "2026-01-02T03:04:05.000Z", keys: ["k"] });
    });
});

describe("FakeAmqpAdapter publish outcomes", () => {
    it("FIFO outcomes: queued errors reject in order, empty queue acks and records", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        fake.control.nextPublish(new AmqpPublishNackError("nacked"), new AmqpConnectionError("blip"));

        await assert.rejects(() => fake.publish("t", new Uint8Array([1])), AmqpPublishNackError);
        await assert.rejects(() => fake.publish("t", new Uint8Array([2])), AmqpConnectionError);
        await fake.publish("t", new Uint8Array([3]), { metadata: { source: "test" } });

        assert.equal(fake.control.published.length, 1, "only acked publishes are recorded");
        assert.equal(fake.control.published[0]?.eventType, "t");
        assert.deepEqual(fake.control.published[0]?.options, { metadata: { source: "test" } });
    });

    it("publish during the recovery window fails fast with the real adapter's message", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();

        await assert.rejects(
            () => fake.publish("t", new Uint8Array([1])),
            (err: unknown) => err instanceof AmqpConnectionError && /not connected \(or recovery in progress\)/.test((err as Error).message),
        );
    });
});

describe("FakeAmqpAdapter delivery", () => {
    it("matches NATS-style wildcards and applies competing-consumer group semantics", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        const got: string[] = [];
        const record = (name: string): Parameters<typeof fake.subscribe>[1] => {
            return async (event) => {
                got.push(`${name}:${event.eventType}`);
            };
        };

        await fake.subscribe(["order.>"], record("g1a"), { group: "g1" });
        await fake.subscribe(["order.>"], record("g1b"), { group: "g1" }); // same group — competes, only one gets it
        await fake.subscribe(["order.*"], record("g2"), { group: "g2" });
        await fake.subscribe(["order.created"], record("fanout")); // no group — always delivered

        await fake.control.deliver("order.created", new Uint8Array([1]));

        assert.equal(got.filter((g) => g.startsWith("g1")).length, 1, "one delivery per distinct group");
        assert.ok(got.includes("g2:order.created"));
        assert.ok(got.includes("fanout:order.created"));
    });

    it("passes metadata through and honors x-event-id", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        let seen: { eventId: string; meta: string | undefined } | null = null;
        await fake.subscribe(["evt"], async (event) => {
            seen = { eventId: event.eventId, meta: event.metadata.get("k") };
        });
        await fake.control.deliver("evt", new Uint8Array(), { metadata: { "x-event-id": "fixed-id", k: "v" } });

        assert.deepEqual(seen, { eventId: "fixed-id", meta: "v" });
    });
});

describe("FakeAmqpAdapter with the real EventBus", () => {
    it("is a drop-in EventAdapter: bus start/publish/stop against the fake", async () => {
        const { create } = await import("@bufbuild/protobuf");
        const { StructSchema } = await import("@bufbuild/protobuf/wkt");

        const fake = FakeAmqpAdapter();
        const bus = createEventBus({ adapter: fake });
        await bus.start();

        // The bus resolves the topic (typeName fallback) and hands the
        // serialized payload to the fake — the record proves interface
        // fidelity end-to-end.
        await bus.publish(StructSchema, create(StructSchema, {}));
        assert.equal(fake.control.published.length, 1);
        assert.equal(fake.control.published[0]?.eventType, StructSchema.typeName);

        await bus.stop();
    });
});
