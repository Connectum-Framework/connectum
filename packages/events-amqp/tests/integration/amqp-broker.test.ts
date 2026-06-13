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

    // Connection-recovery scenarios (broker drop/restart mid-test) are in
    // amqp-recovery.test.ts — they need programmatic container control.
});
