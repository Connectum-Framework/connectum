/**
 * The consumer options that pass validation reach the JetStream consumer unchanged.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/ConsumerOptionsReachServer.integration.test.ts
 *
 * Validation exists so that no value is replaced silently. This is the other half: a value that is
 * accepted, including the edge ones (`maxDeliver: -1`, a fractional `ackWait`), is the value the
 * server holds. The oracle is the consumer configuration the server reports.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";
import type { NatsConsumerOptions } from "../../src/types.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

describe("NATS adapter: consumer options on the server", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    async function consumerConfig(consumerOptions: NatsConsumerOptions) {
        const stream = `co${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream, consumerOptions });
        await adapter.connect();
        const connection = await connect({ servers });
        try {
            await adapter.subscribe(["o.t"], async (_event, ack) => ack(), { group: "g" });
            const manager = await jetstreamManager(connection);
            return (await manager.consumers.info(stream, consumerName("g", "o.t"))).config;
        } finally {
            await connection.close();
            await adapter.disconnect();
        }
    }

    it("sends a fractional ackWait as whole nanoseconds", { timeout: 30_000 }, async () => {
        const config = await consumerConfig({ ackWait: 1500.5 });
        assert.equal(config.ack_wait, 1_500_500_000);
    });

    it("sends maxDeliver -1 (unlimited) and the deliver policy as given", { timeout: 30_000 }, async () => {
        const config = await consumerConfig({ maxDeliver: -1, deliverPolicy: "all" });
        assert.equal(config.max_deliver, -1);
        assert.equal(config.deliver_policy, "all");
    });

    it("keeps the documented defaults when the options are not given", { timeout: 30_000 }, async () => {
        const config = await consumerConfig({});
        assert.equal(config.ack_wait, 30_000_000_000);
        assert.equal(config.max_deliver, 5);
        assert.equal(config.deliver_policy, "new");
    });
});
