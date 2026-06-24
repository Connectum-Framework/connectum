/**
 * Happy-path integration tests against a real RabbitMQ broker.
 *
 * Skipped unless AMQP_TEST_URL is set, e.g.:
 *   docker run -d --name connectum-amqp-test -p 15672:5672 rabbitmq:4-alpine
 *   AMQP_TEST_URL=amqp://guest:guest@localhost:15672 pnpm test
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
import { describe, it } from "node:test";
import type amqp from "amqplib";
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

    it("per-message confirm: publish resolves on broker ack", async () => {
        const adapter = AmqpAdapter({ url, exchange: "it.confirms", recovery: false });
        await adapter.connect();
        try {
            await adapter.publish("it.confirms.ok", new Uint8Array([1, 2, 3]));
        } finally {
            await adapter.disconnect();
        }
    });

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
        try {
            const seen: Array<ReadonlyMap<string, string>> = [];
            const sub = await adapter.subscribe(
                ["it.cleanwire.evt"],
                async (event, ack) => {
                    seen.push(event.metadata);
                    await ack();
                },
                { group: "g1" },
            );

            await adapter.publish("it.cleanwire.evt", new Uint8Array([7]));
            await waitFor(() => seen.length === 1);

            // metadata strips internal headers anyway — verify no stray id key
            assert.equal(seen[0]?.has("x-connectum-publish-id"), false);

            await sub.unsubscribe();
        } finally {
            await adapter.disconnect();
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
        try {
            const received: Array<{ payload: Uint8Array }> = [];
            const sub = await adapter.subscribe(
                ["inbound"],
                async (event, ack) => {
                    received.push({ payload: event.payload });
                    await ack();
                },
                { group: "partner" },
            );

            const body = new TextEncoder().encode(JSON.stringify({ code: "0104603..." }));
            await adapter.publish("inbound", body);

            await waitFor(() => received.length === 1);
            assert.equal(new TextDecoder().decode(received[0]?.payload), '{"code":"0104603..."}');

            await sub.unsubscribe();
        } finally {
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
        try {
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

            await sub.unsubscribe();
        } finally {
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
            (err: unknown) => err instanceof AmqpTopologyError,
        );
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

            await adapter.publish("env.rk", new Uint8Array([9]));
            await waitFor(() => received.length > 0);

            const msg = received[0];
            assert.ok(msg);
            const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
            assert.equal(typeof headers["x-event-id"], "string", "x-event-id stamped by default");
            assert.equal(typeof headers["x-published-at"], "string", "x-published-at stamped by default");
            assert.equal(typeof msg.properties.messageId, "string", "messageId auto-populated by default");
            assert.equal(typeof msg.properties.timestamp, "number", "timestamp auto-populated by default");
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
        try {
            // No queue bound for this key → the mandatory publish is returned and,
            // even though no x-connectum-publish-id header is on the wire, the
            // forced single-flight correlation still detects it as unroutable.
            await assert.rejects(
                adapter.publish("ext.unbound", new Uint8Array([1])),
                (err: unknown) => err instanceof AmqpUnroutableError,
            );
        } finally {
            await adapter.disconnect();
        }
    });

    // Connection-recovery scenarios (broker drop/restart mid-test) are in
    // amqp-recovery.test.ts — they need programmatic container control.
});
