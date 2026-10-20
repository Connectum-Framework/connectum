/**
 * Happy-path integration tests against a real RabbitMQ broker.
 *
 * Skipped unless AMQP_TEST_URL is set. Start a broker, wait until it answers, then run:
 *   docker run -d --name connectum-amqp-test -p 15672:5672 rabbitmq:4.3.6-alpine
 *   until docker exec --user rabbitmq connectum-amqp-test rabbitmq-diagnostics -q check_port_connectivity; do sleep 2; done
 *   AMQP_TEST_URL=amqp://guest:guest@localhost:15672 pnpm test
 *
 * Probe the broker as the `rabbitmq` user. A bare `docker exec` runs as root: when it reaches
 * the container before the server has written its Erlang cookie, root creates the cookie
 * (mode 400, owner root), the server then cannot read it and exits with
 * `.erlang.cookie: eacces`. The image itself boots without any extra flag.
 *
 * These require only a reachable broker (no container control), so they run in
 * CI against a `services: rabbitmq` container. Connection-recovery scenarios
 * (which must crash/restart the broker mid-test) live in amqp-recovery.test.ts
 * and use testcontainers for programmatic lifecycle control.
 *
 * Covers: per-message confirms, mandatory/basic.return correlation (header +
 * single-flight), external topology (assert/check/skip), exchange-to-exchange
 * bindings, serialization contentType, custom transcoding, publish timeout.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type amqp from "amqplib";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import { AmqpTopologyError, AmqpUnroutableError } from "../../src/errors.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `cond` returns true or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(100);
    }
}

describe("AMQP broker integration", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    // The per-message confirm is observed in amqp-contract-gaps.test.ts: there publish() is followed
    // by a basic.get that must find the message at once, with its exchange, routing key, bytes and
    // delivery mode.

    it("mandatory + header correlation: unroutable rejects, concurrent routable resolve", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.mandatory",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { mandatory: true },
        });
        await adapter.connect();
        try {
            // Bind a queue for ONE routing key only
            const sub = await adapter.subscribe(["it.mandatory.bound"], async (_e, ack) => ack(), { group: "g1" });

            const results = await Promise.allSettled([
                adapter.publish("it.mandatory.bound", new Uint8Array([1])),
                adapter.publish("it.mandatory.UNBOUND", new Uint8Array([2])),
                adapter.publish("it.mandatory.bound", new Uint8Array([3])),
            ]);

            assert.equal(results[0]?.status, "fulfilled", "routable #1 must resolve");
            assert.equal(results[2]?.status, "fulfilled", "routable #3 must resolve");
            assert.equal(results[1]?.status, "rejected", "unroutable must reject");
            assert.ok(
                (results[1] as PromiseRejectedResult).reason instanceof AmqpUnroutableError,
                `expected AmqpUnroutableError, got: ${(results[1] as PromiseRejectedResult).reason}`,
            );

            await sub.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("mandatory + single-flight (correlationHeader: false): correlation stays correct", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.singleflight",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { mandatory: true, correlationHeader: false },
        });
        await adapter.connect();
        try {
            const sub = await adapter.subscribe(["it.singleflight.bound"], async (_e, ack) => ack(), { group: "g1" });

            const results = await Promise.allSettled([
                adapter.publish("it.singleflight.bound", new Uint8Array([1])),
                adapter.publish("it.singleflight.UNBOUND", new Uint8Array([2])),
                adapter.publish("it.singleflight.bound", new Uint8Array([3])),
            ]);

            assert.equal(results[0]?.status, "fulfilled");
            assert.equal(results[1]?.status, "rejected");
            assert.ok((results[1] as PromiseRejectedResult).reason instanceof AmqpUnroutableError);
            assert.equal(results[2]?.status, "fulfilled");

            await sub.unsubscribe();
        } finally {
            await adapter.disconnect();
        }
    });

    it("single-flight leaves the wire clean (no x-connectum-publish-id header)", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.cleanwire",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { mandatory: true, correlationHeader: false },
        });
        await adapter.connect();
        // A plain amqplib consumer is the oracle: adapter.subscribe() strips internal
        // headers on delivery, so it could not show a header that is on the wire.
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.cleanwire", "it.cleanwire.evt");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(
                q.queue,
                (m) => {
                    if (m) received.push(m);
                },
                { noAck: true },
            );

            await adapter.publish("it.cleanwire.evt", new Uint8Array([7]));
            await waitFor(() => received.length === 1);

            const headers = (received[0]?.properties.headers ?? {}) as Record<string, unknown>;
            assert.equal(headers["x-connectum-publish-id"], undefined, "the correlation header must not be on the wire");
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });

    it("header correlation (default) puts x-connectum-publish-id on the wire: the probe in the clean-wire test can see it", async () => {
        // Positive control for the clean-wire test above. The documented behaviour of
        // `correlationHeader: true` is a private header "visible on the wire to external
        // consumers"; this test reads it with the same plain amqplib consumer. Without it a
        // probe that never sees the header (wrong queue, stripped properties) would make the
        // clean-wire assertion pass for the wrong reason.
        const adapter = AmqpAdapter({
            url,
            exchange: "it.stampedwire",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { mandatory: true },
        });
        await adapter.connect();
        let conn: amqp.ChannelModel | undefined;
        try {
            conn = await connect(url);
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.stampedwire", "it.stampedwire.evt");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(
                q.queue,
                (m) => {
                    if (m) received.push(m);
                },
                { noAck: true },
            );

            await adapter.publish("it.stampedwire.evt", new Uint8Array([7]));
            await waitFor(() => received.length === 1);

            const headers = (received[0]?.properties.headers ?? {}) as Record<string, unknown>;
            assert.equal(typeof headers["x-connectum-publish-id"], "string", "the correlation header must be on the wire by default");
        } finally {
            // The adapter is released even if opening the probe connection or closing it fails.
            try {
                await conn?.close();
            } finally {
                await adapter.disconnect();
            }
        }
    });

    it("external topology: DLQ-argument queue + queueOverrides consume + JSON contentType", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "partner.direct",
            exchangeType: "direct",
            recovery: false,
            serialization: { contentType: "application/json" },
            topology: {
                exchanges: [{ name: "partner.dlx", type: "direct" }],
                queues: [
                    { name: "partner.dead.v1", durable: true },
                    {
                        name: "partner.inbound.v1",
                        durable: true,
                        arguments: {
                            "x-dead-letter-exchange": "partner.dlx",
                            "x-dead-letter-routing-key": "inbound.dead",
                        },
                    },
                ],
                bindings: [
                    { queue: "partner.dead.v1", source: "partner.dlx", routingKey: "inbound.dead" },
                    { queue: "partner.inbound.v1", source: "partner.direct", routingKey: "inbound" },
                ],
            },
            queueOverrides: {
                partner: { queue: "partner.inbound.v1" },
            },
        });
        await adapter.connect();
        const conn = await connect(url);
        try {
            // The queues are durable: drop what an earlier run left in the dead-letter queue.
            const ch = await conn.createChannel();
            await ch.purgeQueue("partner.dead.v1");
            const received: Array<{ payload: Uint8Array }> = [];
            const sub = await adapter.subscribe(
                ["inbound"],
                async (event, ack, nack) => {
                    received.push({ payload: event.payload });
                    // A message the handler rejects without requeue must leave through the
                    // queue's dead-letter arguments; any other is acknowledged.
                    if (new TextDecoder().decode(event.payload).includes("poison")) {
                        await nack(false);
                    } else {
                        await ack();
                    }
                },
                { group: "partner" },
            );

            const body = new TextEncoder().encode(JSON.stringify({ code: "0104603..." }));
            await adapter.publish("inbound", body);

            await waitFor(() => received.length === 1);
            assert.equal(new TextDecoder().decode(received[0]?.payload), '{"code":"0104603..."}');

            // The rejected message is dead-lettered to partner.dlx with the routing key
            // "inbound.dead", so it lands in partner.dead.v1 with its content type kept.
            const poison = new TextEncoder().encode(JSON.stringify({ code: "poison" }));
            await adapter.publish("inbound", poison);
            await waitFor(() => received.length === 2);

            let dead = await ch.get("partner.dead.v1", { noAck: true });
            for (let i = 0; i < 50 && !dead; i += 1) {
                await sleep(100);
                dead = await ch.get("partner.dead.v1", { noAck: true });
            }
            assert.ok(dead, "the rejected message must reach the dead-letter queue");
            assert.equal(new TextDecoder().decode(dead.content), '{"code":"poison"}');
            assert.equal(dead.properties.contentType, "application/json");
            assert.equal(dead.fields.exchange, "partner.dlx");
            assert.equal(dead.fields.routingKey, "inbound.dead");
            assert.equal(await ch.get("partner.dead.v1", { noAck: true }), false, "the acknowledged message must not be dead-lettered");

            await sub.unsubscribe();
        } finally {
            await conn.close().catch(() => undefined);
            await adapter.disconnect();
        }
    });

    // publishTimeoutMs is covered deterministically in amqp-recovery.test.ts:
    // a fast localhost broker delivers the confirm before any small timeout
    // fires, so a happy-path timing test is inherently flaky. The recovery
    // suite freezes the broker (docker pause) to make the timeout fire.

    it("custom encode/decode hooks: wire transcoding round-trip", async () => {
        // XOR transform — distinguishable from identity on the wire
        const xor = (bytes: Uint8Array): Uint8Array => bytes.map((b) => b ^ 0x5a);

        const adapter = AmqpAdapter({
            url,
            exchange: "it.transcode",
            exchangeType: "topic",
            recovery: false,
            serialization: { contentType: "application/octet-stream", encode: xor, decode: xor },
        });
        await adapter.connect();
        // A plain amqplib consumer reads the frame as the broker holds it: the adapter's own
        // consumer decodes on delivery, so only the raw frame shows that encode really ran.
        const conn = await connect(url);
        try {
            const raw = await conn.createChannel();
            const rawQueue = await raw.assertQueue("", { exclusive: true });
            await raw.bindQueue(rawQueue.queue, "it.transcode", "it.transcode.evt");

            const received: Uint8Array[] = [];
            const sub = await adapter.subscribe(
                ["it.transcode.evt"],
                async (event, ack) => {
                    received.push(event.payload);
                    await ack();
                },
                { group: "g1" },
            );

            const original = new TextEncoder().encode("round-trip");
            await adapter.publish("it.transcode.evt", original);

            await waitFor(() => received.length === 1);
            assert.equal(new TextDecoder().decode(received[0]), "round-trip");

            const onWire = await raw.get(rawQueue.queue, { noAck: true });
            assert.ok(onWire, "the raw queue must hold the published frame");
            assert.deepEqual(new Uint8Array(onWire.content), xor(original), "the bytes on the wire are the encode hook's output");
            assert.notDeepEqual(new Uint8Array(onWire.content), original, "the payload must not travel untransformed");
            assert.equal(onWire.properties.contentType, "application/octet-stream");

            await sub.unsubscribe();
        } finally {
            await conn.close().catch(() => undefined);
            await adapter.disconnect();
        }
    });

    it("exchange-to-exchange binding routes through both exchanges", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.e2e.ingress",
            exchangeType: "topic",
            recovery: false,
            topology: {
                exchanges: [{ name: "it.e2e.audit", type: "topic" }],
                bindings: [{ exchange: "it.e2e.audit", source: "it.e2e.ingress", routingKey: "#" }],
            },
            queueOverrides: { audit: { queue: "it.e2e.audit.q" } },
        });
        await adapter.connect();
        try {
            // Consume from a queue bound to the DOWNSTREAM exchange
            const consumer = AmqpAdapter({
                url,
                exchange: "it.e2e.audit",
                exchangeType: "topic",
                recovery: false,
            });
            await consumer.connect();

            const received: string[] = [];
            const sub = await consumer.subscribe(
                ["it.e2e.evt"],
                async (event, ack) => {
                    received.push(event.eventType);
                    await ack();
                },
                { group: "audit" },
            );

            // Publish to the UPSTREAM exchange — must route through e2e binding
            await adapter.publish("it.e2e.evt", new Uint8Array([1]));

            await waitFor(() => received.length === 1);
            assert.equal(received[0], "it.e2e.evt");

            await sub.unsubscribe();
            await consumer.disconnect();
        } finally {
            await adapter.disconnect();
        }
    });

    it("topologyMode check: passes on existing objects, fails fast on missing queue", async () => {
        // Objects exist from the previous test (durable)
        const ok = AmqpAdapter({
            url,
            exchange: "partner.direct",
            recovery: false,
            topologyMode: "check",
            topology: { queues: [{ name: "partner.inbound.v1" }] },
        });
        await ok.connect();
        await ok.disconnect();

        const missing = AmqpAdapter({
            url,
            exchange: "partner.direct",
            recovery: false,
            topologyMode: "check",
            topology: { queues: [{ name: "it.does.not.exist" }] },
        });
        await assert.rejects(
            () => missing.connect(),
            (err: unknown) => {
                assert.ok(err instanceof AmqpTopologyError, `expected AmqpTopologyError, got: ${String(err)}`);
                // The documented identity of the failing object, and the broker's own NOT_FOUND reply as the cause.
                assert.deepEqual(err.object, { kind: "queue", name: "it.does.not.exist" });
                assert.equal((err.cause as { code?: number } | undefined)?.code, 404);
                return true;
            },
        );
        // check mode only looks: a queue that is missing is not created on the adapter's behalf.
        const probeConn = await connect(url);
        try {
            const probe = await probeConn.createChannel();
            probe.on("error", () => {});
            await assert.rejects(() => probe.checkQueue("it.does.not.exist"));
        } finally {
            await probeConn.close().catch(() => undefined);
        }
    });

    // ── External-contract publish mode (#161) ──────────────────────────────
    // The oracle here is the RAW wire frame consumed via a plain amqplib channel
    // — NOT adapter.subscribe(), which strips the envelope on delivery and would
    // hide a dirty wire (tautological). We assert msg.properties directly.

    it("external contract: the wire frame carries ONLY contract headers, no EventBus envelope (raw amqplib oracle)", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.external",
            exchangeType: "topic",
            recovery: false,
            serialization: { contentType: "application/json" },
            publisherOptions: { externalContract: true },
        });
        await adapter.connect(); // asserts the exchange so the raw consumer can bind
        const amqplib = await import("amqplib");
        const conn = await amqplib.connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.external", "ext.clean");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(q.queue, (m) => { if (m) received.push(m); }, { noAck: true });

            await adapter.publish("ext.clean", new Uint8Array([1, 2, 3]), { metadata: { "x-trace-id": "trace-1" } });
            await waitFor(() => received.length > 0);

            const msg = received[0];
            assert.ok(msg);
            const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
            // The caller's contract header passes through unchanged...
            assert.equal(headers["x-trace-id"], "trace-1");
            // ...and NONE of the EventBus envelope reaches the wire.
            assert.equal(headers["x-event-id"], undefined, "x-event-id must not be on the wire");
            assert.equal(headers["x-published-at"], undefined, "x-published-at must not be on the wire");
            assert.equal(headers["x-connectum-publish-id"], undefined, "publish-id header must not be on the wire");
            assert.equal(msg.properties.messageId, undefined, "messageId must not be auto-populated");
            assert.equal(msg.properties.timestamp, undefined, "timestamp must not be auto-populated");
            // Only contract-specified properties remain.
            assert.equal(msg.properties.contentType, "application/json");
            assert.deepEqual(new Uint8Array(msg.content), new Uint8Array([1, 2, 3]));
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });

    it("external contract: caller-supplied messageId/timestamp are used as-is (raw amqplib oracle)", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.external.id",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { externalContract: true },
        });
        await adapter.connect();
        const amqplib = await import("amqplib");
        const conn = await amqplib.connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.external.id", "ext.id");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(q.queue, (m) => { if (m) received.push(m); }, { noAck: true });

            // The contract requires a specific id/timestamp — supplied per publish.
            await adapter.publish("ext.id", new Uint8Array([7]), { messageId: "contract-msg-1", timestamp: 1_700_000_000 });
            await waitFor(() => received.length > 0);

            const msg = received[0];
            assert.ok(msg);
            // The caller's values reach the wire verbatim (not auto-generated)...
            assert.equal(msg.properties.messageId, "contract-msg-1");
            assert.equal(msg.properties.timestamp, 1_700_000_000);
            // ...and the EventBus envelope is still absent.
            const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
            assert.equal(headers["x-event-id"], undefined);
            assert.equal(headers["x-published-at"], undefined);
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });

    it("default mode still stamps the EventBus envelope on the wire (raw amqplib oracle, regression)", async () => {
        const adapter = AmqpAdapter({ url, exchange: "it.envelope", exchangeType: "topic", recovery: false });
        await adapter.connect();
        const amqplib = await import("amqplib");
        const conn = await amqplib.connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.envelope", "env.rk");
            const received: amqp.ConsumeMessage[] = [];
            await ch.consume(q.queue, (m) => { if (m) received.push(m); }, { noAck: true });

            const before = Date.now();
            await adapter.publish("env.rk", new Uint8Array([9]));
            const after = Date.now();
            await waitFor(() => received.length > 0);

            const msg = received[0];
            assert.ok(msg);
            const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
            const eventId = headers["x-event-id"];
            assert.equal(typeof eventId, "string", "x-event-id stamped by default");
            assert.ok((eventId as string).length > 0, "x-event-id is not empty");
            assert.equal(msg.properties.messageId, eventId, "messageId carries the same identity as x-event-id");
            // x-published-at is the publish instant as an ISO-8601 UTC timestamp.
            const publishedAt = headers["x-published-at"];
            assert.equal(typeof publishedAt, "string", "x-published-at stamped by default");
            assert.equal(new Date(publishedAt as string).toISOString(), publishedAt, "x-published-at is an ISO-8601 instant");
            assert.ok(Date.parse(publishedAt as string) >= before && Date.parse(publishedAt as string) <= after, "x-published-at is the instant of this publish");
            // The AMQP 0-9-1 timestamp property counts whole seconds since the epoch.
            const timestamp = msg.properties.timestamp as number;
            assert.ok(timestamp >= Math.floor(before / 1000) && timestamp <= Math.ceil(after / 1000), `timestamp ${timestamp} is the second of this publish`);
        } finally {
            await conn.close();
            await adapter.disconnect();
        }
    });

    it("external contract + mandatory: unroutable rejects via single-flight, no publish-id header on the wire", async () => {
        const adapter = AmqpAdapter({
            url,
            exchange: "it.external.mandatory",
            exchangeType: "topic",
            recovery: false,
            publisherOptions: { externalContract: true, mandatory: true },
        });
        await adapter.connect();
        const conn = await connect(url);
        try {
            const ch = await conn.createChannel();
            const q = await ch.assertQueue("", { exclusive: true });
            await ch.bindQueue(q.queue, "it.external.mandatory", "ext.bound");

            // No queue bound for this key → the mandatory publish is returned and,
            // even though no x-connectum-publish-id header is on the wire, the
            // forced single-flight correlation still detects it as unroutable.
            await assert.rejects(
                adapter.publish("ext.unbound", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpUnroutableError,
            );

            // A routable mandatory publish resolves, and its frame has no correlation header.
            await adapter.publish("ext.bound", new Uint8Array([2]));
            const msg = await ch.get(q.queue, { noAck: true });
            assert.ok(msg, "the routable message must be on the queue");
            const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
            assert.equal(headers["x-connectum-publish-id"], undefined, "external-contract mode keeps the correlation header off the wire");
            assert.equal(headers["x-event-id"], undefined);
        } finally {
            await conn.close().catch(() => undefined);
            await adapter.disconnect();
        }
    });

    // A handler that settles the delivery itself and then throws must not make the
    // adapter settle the same tag again: the broker answers a second settlement with
    // `precondition_failed: unknown delivery tag` and closes the consumer channel,
    // which would leave the queue without a consumer.
    for (const settleWith of ["ack", "reject"] as const) {
        it(`${settleWith}() followed by a throw leaves the consumer alive and does not redeliver`, async () => {
            const run = randomUUID().slice(0, 8);
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown): void => {
                unhandled.push(reason);
            };
            process.on("unhandledRejection", onUnhandled);
            const lifecycleTypes: string[] = [];
            const adapter = AmqpAdapter({
                url,
                exchange: `it.single.${run}`,
                recovery: true,
                lifecycle: { onLifecycle: (event) => lifecycleTypes.push(event.type) },
            });
            await adapter.connect();
            try {
                const seen: string[] = [];
                const sub = await adapter.subscribe(
                    ["it.single.*"],
                    async (event, ack, nack) => {
                        seen.push(`${event.eventType}#${event.attempt}`);
                        if (settleWith === "ack") {
                            await ack();
                        } else {
                            await nack(false);
                        }
                        throw new Error("failed after settling");
                    },
                    { group: `single-${run}` },
                );

                await adapter.publish("it.single.one", new Uint8Array([1]));
                await waitFor(() => seen.length >= 1);
                await adapter.publish("it.single.two", new Uint8Array([2]));
                await waitFor(() => seen.length >= 2);
                // Give a wrongly requeued copy time to come back before asserting.
                await sleep(500);

                assert.deepEqual(seen, ["it.single.one#1", "it.single.two#1"]);
                assert.deepEqual(
                    lifecycleTypes.filter((type) => type !== "connected"),
                    [],
                    "no diagnostic event: the second settlement is a silent no-op",
                );
                assert.equal(unhandled.length, 0);
                await sub.unsubscribe();
            } finally {
                process.off("unhandledRejection", onUnhandled);
                await adapter.disconnect();
                // Named-group queues and the exchange are durable: remove this run's
                // objects so a long-lived local broker does not accumulate them.
                const admin = await connect(url);
                try {
                    const ch = await admin.createChannel();
                    await ch.deleteQueue(`it.single.${run}.single-${run}`).catch(() => undefined);
                    await ch.deleteExchange(`it.single.${run}`).catch(() => undefined);
                } finally {
                    await admin.close();
                }
            }
        });
    }

    for (const [label, pattern] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`subscribe() rejects ${label} and declares no queue`, async () => {
            const run = randomUUID();
            const exchange = `it.emptyseg.${run}`;
            const group = `g-${run}`;
            const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
            await adapter.connect();
            const admin = await connect(url);
            try {
                await assert.rejects(
                    adapter.subscribe(["ok.one", pattern], async () => undefined, { group }),
                    (error: unknown) => error instanceof TypeError && error.message.startsWith(`AmqpAdapter: subscription pattern "${pattern}" has an empty segment (`),
                );

                // A failed checkQueue closes its channel, so the probe gets a channel of its own.
                const probe = await admin.createChannel();
                probe.on("error", () => undefined);
                await assert.rejects(() => probe.checkQueue(`${exchange}.${group}`), "the rejected call declared no queue for its good pattern either");
            } finally {
                await adapter.disconnect();
                const cleanup = await admin.createChannel();
                await cleanup.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
                await cleanup.deleteExchange(exchange).catch(() => undefined);
                await admin.close();
            }
        });
    }

    it("subscribe() still declares the queue for literal, single-segment wildcard and tail wildcard patterns", async () => {
        const run = randomUUID();
        const exchange = `it.emptyseg.${run}`;
        const group = `g-${run}`;
        const adapter = AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        await adapter.connect();
        const admin = await connect(url);
        try {
            await adapter.subscribe(["ok.one", "ok.*", "ok.>"], async () => undefined, { group });

            const probe = await admin.createChannel();
            const declared = await probe.checkQueue(`${exchange}.${group}`);
            assert.equal(declared.queue, `${exchange}.${group}`);
        } finally {
            await adapter.disconnect();
            const cleanup = await admin.createChannel();
            await cleanup.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
            await cleanup.deleteExchange(exchange).catch(() => undefined);
            await admin.close();
        }
    });

    // Connection-recovery scenarios (broker drop/restart mid-test) are in
    // amqp-recovery.test.ts — they need programmatic container control.
});
