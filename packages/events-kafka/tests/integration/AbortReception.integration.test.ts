/**
 * The shutdown signal ends reception, against a real Kafka: when the signal given to the bus
 * aborts, a handler that is running finishes and its offset is committed, a message that arrives
 * after the abort is not handled by that bus, and the next consumer of the group receives it
 * exactly once. The group's committed offset ends past both messages.
 *
 * Set KAFKA_TEST_URL to a comma-separated list of bootstrap servers of a real single-node broker.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { Kafka, logLevel } from "kafkajs";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import { createTopicWithLeader } from "./createTopic.ts";

const KAFKA_TEST_URL = process.env.KAFKA_TEST_URL;

async function until(condition: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(50);
    }
}

/** Holds the first handler until the test lets it go, so it provably runs across the abort. */
function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

describe("EventBus reception after the shutdown signal aborts on Kafka", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    it("a running handler finishes, a message that arrives after the abort goes to the next consumer exactly once, and the offset ends past both", { timeout: 180_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const topic = `it.abort.in.${id}`;
        const group = `abort-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: topic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.AbortReceptionService", methods: [method] } as any;

        const admin = new Kafka({ clientId: "integration-abort-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();
        const newAdapter = () =>
            KafkaAdapter({
                brokers,
                clientId: `integration-abort-${randomUUID()}`,
                logLevel: "error",
                consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
            });
        const publisher = newAdapter();
        const firstGate = gate();
        const handledByFirst: string[] = [];
        const handledBySecond: string[] = [];
        const controller = new AbortController();

        const newBus = (handled: string[], onFirst?: () => Promise<void>) =>
            createEventBus({
                adapter: newAdapter(),
                group,
                drainTimeout: 20_000,
                routes: [
                    (router) => {
                        router.service(service, {
                            simpleEvent: async (_message: unknown, ctx: { eventId: string }) => {
                                handled.push(ctx.eventId);
                                if (onFirst && handled.length === 1) {
                                    await onFirst();
                                }
                            },
                            // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                        } as any);
                    },
                ],
            });

        const first = newBus(handledByFirst, () => firstGate.wait);
        const second = newBus(handledBySecond);

        try {
            await createTopicWithLeader(admin, topic);
            await publisher.connect({ serviceName: "integration-abort-publisher" });
            await first.start({ signal: controller.signal });

            await publisher.publish(topic, new Uint8Array());
            await until(() => handledByFirst.length === 1, "first handler start");

            controller.abort();
            await publisher.publish(topic, new Uint8Array());
            firstGate.release();

            await sleep(2_000);
            assert.equal(handledByFirst.length, 1, `the bus must not handle a message that arrives after the abort (handled ${handledByFirst.length})`);

            await first.stop();
            await second.start();
            await until(() => handledBySecond.length >= 1, "next consumer delivery");
            await sleep(1_000);
            assert.equal(handledBySecond.length, 1, `the next consumer must receive the message exactly once (got ${handledBySecond.length})`);
            await second.stop();

            const [committed] = await admin.fetchOffsets({ groupId: group, topics: [topic] });
            const offset = committed?.partitions[0]?.offset;
            assert.equal(offset, "2", `the committed offset must be past both messages (got ${String(offset)})`);
        } finally {
            firstGate.release();
            await first.stop().catch(() => undefined);
            await second.stop().catch(() => undefined);
            await publisher.disconnect().catch(() => undefined);
            await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
            await admin.disconnect();
        }
    });
});
