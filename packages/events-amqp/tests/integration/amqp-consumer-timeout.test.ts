/**
 * Consumer acknowledgement timeout, observed on a live broker.
 *
 * RabbitMQ ends a consumer that holds a delivery unacknowledged for longer
 * than `consumer_timeout`. This suite lowers the timeout to its documented
 * minimum on a dedicated broker and records what the adapter sees.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";
import type { AmqpLifecycleEvent, AmqpQueueOverride } from "../../src/types.ts";

const RUN = process.env.RUN_RECOVERY_TESTS === "1";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("waitFor: condition not met in time");
        }
        await sleep(200);
    }
}

interface Observation {
    readonly deliveries: Array<{ at: number; attempt: number }>;
    readonly events: Array<{ at: number; event: AmqpLifecycleEvent }>;
}

describe("AMQP consumer acknowledgement timeout (testcontainers)", { skip: RUN ? false : "RUN_RECOVERY_TESTS != 1", concurrency: 1 }, () => {
    let container: StartedTestContainer;
    let url: string;

    before(async () => {
        container = await new GenericContainer("rabbitmq:4-alpine")
            .withExposedPorts(5672)
            .withCopyContentToContainer([{ content: "consumer_timeout = 60000\n", target: "/etc/rabbitmq/conf.d/99-consumer-timeout.conf" }])
            .start();
        url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
    });

    after(async () => {
        await container?.stop();
    });

    /** A handler that never settles holds one delivery until the broker's acknowledgement timeout ends the consumer. */
    async function observeStuckHandler(exchange: string, override: AmqpQueueOverride | undefined, windowMs = 120_000): Promise<Observation> {
        const events: Observation["events"] = [];
        const deliveries: Observation["deliveries"] = [];
        const startedAt = Date.now();
        const adapter = AmqpAdapter({
            url,
            exchange,
            exchangeType: "topic",
            recovery: { initialDelay: 100, maxDelay: 500 },
            ...(override === undefined ? {} : { queueOverrides: { g: override } }),
            lifecycle: { onLifecycle: (event) => events.push({ at: Date.now() - startedAt, event }) },
        });
        await adapter.connect();
        try {
            await adapter.subscribe(
                [`${exchange}.evt`],
                async (event) => {
                    deliveries.push({ at: Date.now() - startedAt, attempt: event.attempt });
                    await new Promise<never>(() => undefined);
                },
                { group: "g" },
            );
            await adapter.publish(`${exchange}.evt`, new TextEncoder().encode("stuck"));

            await waitFor(() => events.some((e) => e.event.type === "consumer-restored") && deliveries.length >= 2, windowMs).catch(() => undefined);
            await sleep(1_000);
        } finally {
            await adapter.disconnect().catch(() => undefined);
        }
        return { deliveries, events };
    }

    it("a quorum queue ends a consumer stuck past the timeout with a cancel; it is restored and the message comes back", { timeout: 240_000 }, async () => {
        const seen = await observeStuckHandler("toq", { queue: "toq.quorum", arguments: { "x-queue-type": "quorum" } });

        const lost = seen.events.find((e) => e.event.type === "consumer-lost");
        assert.ok(lost?.event.type === "consumer-lost", "the broker ended the stuck consumer");
        assert.equal(lost.event.queue, "toq.quorum");
        assert.equal(lost.event.cause, "cancelled", "a quorum queue cancels the consumer; the channel stays open");
        assert.equal(lost.event.willRestore, true);
        assert.ok(lost.at >= 55_000, `the consumer was ended by the 60 s timeout, not earlier (at ${lost.at} ms)`);

        const restored = seen.events.find((e) => e.event.type === "consumer-restored");
        assert.ok(restored?.event.type === "consumer-restored");
        assert.equal(restored.event.attempt, 1);

        assert.deepEqual(
            seen.deliveries.map((d) => d.attempt),
            [1, 2],
            "the unacknowledged message was redelivered to the restored consumer",
        );
    });
});
