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
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
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
    it("double connect() and connect() during recovery throw 'already connected'; after give-up and after disconnect() a fresh connect() works", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        await assert.rejects(() => fake.connect(), /already connected/);

        await fake.subscribe(["evt"], async () => undefined);
        fake.control.dropConnection();
        await assert.rejects(() => fake.connect(), /already connected/, "connect() during recovery mirrors the real non-null connection");

        fake.control.exhaustRecovery();
        await fake.connect(); // the real adapter drops the dead connection on give-up
        const afterGiveUp = await fake.control.deliver("evt", new Uint8Array());
        assert.equal(afterGiveUp.delivered, 0, "a connect() after give-up does not resurrect the old subscription");

        await fake.disconnect();
        await fake.connect(); // CLOSED → fresh connect works, like the real adapter
    });

    it("after give-up, subscribe() and publish() reject with the same class and message as the real adapter in that state", async () => {
        // Oracle: a real adapter without a connection. Once recovery gives up,
        // the real adapter drops its connection and takes exactly these
        // branches; amqplib is only loaded inside connect(), so no broker is
        // needed to observe them.
        const real = AmqpAdapter({ url: "amqp://unused.invalid" });
        const realWithRetry = AmqpAdapter({ url: "amqp://unused.invalid", publishRetry: { maxRetries: 3 } });
        const failureOf = async (op: () => Promise<unknown>): Promise<{ readonly name: string; readonly message: string; readonly typed: boolean }> => {
            try {
                await op();
            } catch (err) {
                return { name: (err as Error).name, message: (err as Error).message, typed: err instanceof AmqpConnectionError };
            }
            throw new Error("expected the operation to reject");
        };

        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();
        fake.control.exhaustRecovery();

        const expectedSubscribe = await failureOf(() => real.subscribe(["evt"], async () => undefined));
        const expectedPublish = await failureOf(() => real.publish("evt", new Uint8Array([1])));
        const expectedRetryingPublish = await failureOf(() => realWithRetry.publish("evt", new Uint8Array([1])));
        assert.equal(expectedSubscribe.typed, true, "the oracle itself is the typed connection error");
        assert.deepEqual(expectedRetryingPublish, expectedPublish, "publishRetry does not change the dead-state error");

        assert.deepEqual(await failureOf(() => fake.subscribe(["evt"], async () => undefined)), expectedSubscribe);
        assert.deepEqual(await failureOf(() => fake.publish("evt", new Uint8Array([1]))), expectedPublish);
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

    it("counts one settlement per delivery per handler: the first wins, a bare nack() requeues", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();

        await fake.subscribe(
            ["evt"],
            async (_e, ack, nack) => {
                await ack();
                await nack(false);
                await nack();
            },
            { group: "ack-first" },
        );
        await fake.subscribe(
            ["evt"],
            async (_e, ack, nack) => {
                await nack(false);
                await ack();
            },
            { group: "reject-first" },
        );
        await fake.subscribe(["evt"], async (_e, _ack, nack) => nack(), { group: "bare-nack" });
        await fake.subscribe(
            ["evt"],
            async (_e, ack) => {
                await ack();
                throw new Error("failed after settling");
            },
            { group: "ack-then-throw" },
        );

        const result = await fake.control.deliver("evt", new Uint8Array());
        assert.deepEqual(result, { delivered: 4, acked: 2, nacked: 1, requeued: 1, failed: 1 });
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

describe("FakeAmqpAdapter consumer loss", () => {
    const noop: Parameters<ReturnType<typeof FakeAmqpAdapter>["subscribe"]>[1] = async () => undefined;

    it("a lost consumer stops receiving deliveries and reports one consumer-lost with the recovery setting", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        const got: string[] = [];
        await fake.subscribe(["evt"], async () => void got.push("g"), { group: "g" });

        fake.control.loseConsumer();
        const result = await fake.control.deliver("evt", new Uint8Array());

        assert.equal(result.delivered, 0);
        assert.equal(got.length, 0);
        assert.deepEqual(
            events.filter((e) => e.type !== "connected"),
            [{ type: "consumer-lost", queue: "g", cause: "cancelled", willRestore: true }],
        );
    });

    it("carries the cause and the channel exception, and targets one queue by name", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        const got: string[] = [];
        await fake.subscribe(["evt"], async () => void got.push("a"), { group: "a" });
        await fake.subscribe(["evt"], async () => void got.push("b"), { group: "b" });
        const failure = new Error("PRECONDITION_FAILED");

        fake.control.loseConsumer({ queue: "a", cause: "channel-closed", error: failure });
        await fake.control.deliver("evt", new Uint8Array());

        assert.deepEqual(got, ["b"], "only the other queue still receives");
        const lost = events.filter((e) => e.type === "consumer-lost");
        assert.deepEqual(lost, [{ type: "consumer-lost", queue: "a", cause: "channel-closed", error: failure, willRestore: true }]);
    });

    it("a subscription without a group is named fake.sub-N by registration order", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        await fake.subscribe(["evt"], noop, { group: "g" });
        await fake.subscribe(["evt"], noop);

        fake.control.loseConsumer({ queue: "fake.sub-2" });

        assert.deepEqual(
            events.filter((e) => e.type === "consumer-lost").map((e) => (e.type === "consumer-lost" ? e.queue : "")),
            ["fake.sub-2"],
        );
    });

    it("restoreConsumers resumes delivery and reports consumer-restored once per lost subscription", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        const got: string[] = [];
        await fake.subscribe(["evt"], async () => void got.push("a"), { group: "a" });
        await fake.subscribe(["evt"], async () => void got.push("b"), { group: "b" });
        fake.control.loseConsumer();

        fake.control.restoreConsumers();
        await fake.control.deliver("evt", new Uint8Array());

        assert.deepEqual(got.sort(), ["a", "b"]);
        assert.deepEqual(
            events.filter((e) => e.type === "consumer-restored"),
            [
                { type: "consumer-restored", queue: "a", attempt: 1 },
                { type: "consumer-restored", queue: "b", attempt: 1 },
            ],
        );
    });

    it("recovery: false reports willRestore:false and refuses restoreConsumers", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ recovery: false, lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        await fake.subscribe(["evt"], noop, { group: "g" });

        fake.control.loseConsumer();

        const lost = events.find((e) => e.type === "consumer-lost");
        assert.ok(lost?.type === "consumer-lost");
        assert.equal(lost.willRestore, false);
        assert.throws(() => fake.control.restoreConsumers(), /recovery is disabled/);
    });

    it("an unsubscribed subscription is neither lost nor restored", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        const sub = await fake.subscribe(["evt"], noop, { group: "g" });
        await sub.unsubscribe();

        assert.throws(() => fake.control.loseConsumer(), /no live subscription/);

        const other = await fake.subscribe(["evt"], noop, { group: "h" });
        fake.control.loseConsumer();
        await other.unsubscribe();
        assert.throws(() => fake.control.restoreConsumers(), /no lost consumer/);
        assert.equal(events.filter((e) => e.type === "consumer-restored").length, 0);
    });

    it("a lost consumer is not lost twice, and a second restore without a loss throws", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        await fake.subscribe(["evt"], noop, { group: "g" });

        fake.control.loseConsumer();
        assert.throws(() => fake.control.loseConsumer(), /no live subscription/);
        fake.control.restoreConsumers();
        assert.throws(() => fake.control.restoreConsumers(), /no lost consumer/);
    });

    it("refuses to act on a disconnected or recovering adapter and on an unknown queue", async () => {
        const fake = FakeAmqpAdapter();
        assert.throws(() => fake.control.loseConsumer(), /not 'connected'/);
        await fake.connect();
        await fake.subscribe(["evt"], noop, { group: "g" });
        assert.throws(() => fake.control.loseConsumer({ queue: "missing" }), /no live subscription on queue 'missing'/);

        fake.control.dropConnection();
        assert.throws(() => fake.control.loseConsumer(), /not 'connected'/);
        assert.throws(() => fake.control.restoreConsumers(), /not 'connected'/);
    });

    it("connection recovery brings a lost consumer back silently", async () => {
        const events: AmqpLifecycleEvent[] = [];
        const fake = FakeAmqpAdapter({ lifecycle: { onLifecycle: (event) => events.push(event) } });
        await fake.connect();
        const got: string[] = [];
        await fake.subscribe(["evt"], async () => void got.push("g"), { group: "g" });
        fake.control.loseConsumer();

        fake.control.dropConnection();
        fake.control.completeRecovery();
        await fake.control.deliver("evt", new Uint8Array());

        assert.deepEqual(got, ["g"]);
        assert.equal(events.filter((e) => e.type === "consumer-restored").length, 0);
    });
});

describe("FakeAmqpAdapter subscription validation parity", () => {
    const rejected: Array<{ type: "topic" | "direct" | "fanout" | "headers"; pattern: string; message: RegExp }> = [
        { type: "topic", pattern: "user.>.b", message: /outside the terminal segment/ },
        { type: "topic", pattern: "#", message: /contains "#"/ },
        { type: "topic", pattern: "user.#", message: /contains "#"/ },
        { type: "direct", pattern: "user.*", message: /direct exchange matches binding keys literally/ },
        { type: "direct", pattern: "user.>", message: /direct exchange matches binding keys literally/ },
        { type: "fanout", pattern: "user.>.b", message: /outside the terminal segment/ },
        { type: "headers", pattern: ">.user.>", message: /outside the terminal segment/ },
    ];

    for (const { type, pattern, message } of rejected) {
        it(`rejects "${pattern}" on a ${type} exchange with the real adapter's error, and registers nothing`, async () => {
            const fake = FakeAmqpAdapter({ exchangeType: type });
            await fake.connect();

            await assert.rejects(
                () => fake.subscribe([pattern], async () => undefined),
                (err: unknown) => err instanceof TypeError && message.test(err.message),
            );
            const result = await fake.control.deliver("user.created", new Uint8Array());
            assert.equal(result.delivered, 0);
        });
    }

    it("accepts what the real adapter accepts: wildcards on topic, literal # on direct, literals everywhere", async () => {
        const topic = FakeAmqpAdapter();
        await topic.connect();
        await topic.subscribe(["user.*", "user.>", "a*b.c"], async () => undefined);

        const direct = FakeAmqpAdapter({ exchangeType: "direct" });
        await direct.connect();
        await direct.subscribe(["#", "user.created"], async () => undefined);
    });

    it("accepts a wildcard on a direct exchange when the operator owns the bindings (check, skip)", async () => {
        for (const topologyMode of ["check", "skip"] as const) {
            const fake = FakeAmqpAdapter({ exchangeType: "direct", topologyMode });
            await fake.connect();
            await fake.subscribe(["user.*", "user.>"], async () => undefined);
        }
    });

    it("accepts wildcards on fanout and headers exchanges in every topology mode", async () => {
        for (const exchangeType of ["fanout", "headers"] as const) {
            for (const topologyMode of ["assert", "check", "skip"] as const) {
                const fake = FakeAmqpAdapter({ exchangeType, topologyMode });
                await fake.connect();
                await fake.subscribe(["user.*", "user.>", ">"], async () => undefined);
            }
        }
    });

    it("keeps # literal on a direct exchange: it does not match an unrelated key", async () => {
        const fake = FakeAmqpAdapter({ exchangeType: "direct" });
        await fake.connect();
        const seen: string[] = [];
        await fake.subscribe(["#"], async (event) => void seen.push(event.eventType));

        await fake.control.deliver("user", new Uint8Array());
        await fake.control.deliver("#", new Uint8Array());

        assert.deepEqual(seen, ["#"]);
    });

    it("validates a subscribe parked during recovery before parking it", async () => {
        const fake = FakeAmqpAdapter();
        await fake.connect();
        fake.control.dropConnection();

        await assert.rejects(
            () => fake.subscribe(["user.#"], async () => undefined),
            /contains "#"/,
        );
    });
});

describe("FakeAmqpAdapter delivery follows the configured exchange type", () => {
    async function received(exchangeType: "topic" | "direct" | "fanout" | "headers", patterns: string[], keys: string[], topologyMode?: "assert" | "check" | "skip"): Promise<string[]> {
        const fake = FakeAmqpAdapter({ exchangeType, ...(topologyMode === undefined ? {} : { topologyMode }) });
        await fake.connect();
        const seen: string[] = [];
        await fake.subscribe(patterns, async (event) => void seen.push(event.eventType), { group: "g" });
        for (const key of keys) {
            await fake.control.deliver(key, new Uint8Array());
        }
        return seen;
    }

    const KEYS = ["user.created", "order.created", "user"];

    it("fanout delivers every message to a subscription whose pattern does not match it", async () => {
        assert.deepEqual(await received("fanout", ["user.created"], KEYS), KEYS);
        assert.deepEqual(await received("fanout", ["user.*"], KEYS), KEYS);
    });

    it("headers delivers every message to a subscription whose pattern does not match it", async () => {
        assert.deepEqual(await received("headers", ["user.created"], KEYS), KEYS);
        assert.deepEqual(await received("headers", ["user.>"], KEYS), KEYS);
    });

    it("direct delivers only on an identical routing key", async () => {
        assert.deepEqual(await received("direct", ["user.created"], KEYS), ["user.created"]);
    });

    it("direct with operator-owned bindings still filters handlers by the subscription pattern", async () => {
        assert.deepEqual(await received("direct", ["user.*"], KEYS, "skip"), ["user.created"]);
    });

    it("topic delivers by the EventBus matcher", async () => {
        assert.deepEqual(await received("topic", ["user.*"], KEYS), ["user.created"]);
        assert.deepEqual(await received("topic", ["user.>"], KEYS), ["user.created"]);
    });

    it("fanout still delivers once per distinct group and to every group-less subscription", async () => {
        const fake = FakeAmqpAdapter({ exchangeType: "fanout" });
        await fake.connect();
        let a = 0;
        let b = 0;
        let free = 0;
        await fake.subscribe(["x.1"], async () => void a++, { group: "g" });
        await fake.subscribe(["x.2"], async () => void b++, { group: "g" });
        await fake.subscribe(["x.3"], async () => void free++);
        const result = await fake.control.deliver("other", new Uint8Array());
        assert.equal(result.delivered, 2);
        assert.equal(a + b, 1);
        assert.equal(free, 1);
    });
});
