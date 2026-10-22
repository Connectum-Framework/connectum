/**
 * A relay handler (consume, publish another event) that is still running when `EventBus.stop()`
 * begins, against a real Kafka: its `ctx.publish` reaches the broker before the adapter is
 * disconnected, the input offset is committed (so the group does not see the message again) and
 * the relayed event is delivered exactly once.
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

describe("EventBus relay during stop() on Kafka", { skip: KAFKA_TEST_URL === undefined ? "KAFKA_TEST_URL not set" : false, concurrency: 1 }, () => {
    const brokers = (KAFKA_TEST_URL as string).split(",").map((b) => b.trim());

    it("a handler that relays through ctx.publish while stop() runs delivers the relayed event once and commits the input offset", { timeout: 180_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const inTopic = `it.relay.in.${id}`;
        const outTopic = `it.relay.out.${id}`;
        const group = `relay-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayService", methods: [method] } as any;

        const admin = new Kafka({ clientId: "integration-relay-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();
        const newAdapter = () =>
            KafkaAdapter({
                brokers,
                clientId: `integration-relay-${randomUUID()}`,
                logLevel: "error",
                consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
            });
        const publisher = newAdapter();
        const sink = newAdapter();
        let handlerStarted = false;
        let relayed: Promise<void> | undefined;
        const received: string[] = [];

        const bus = createEventBus({
            adapter: newAdapter(),
            group,
            drainTimeout: 20_000,
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async (_message: unknown, ctx: { publish: (schema: typeof EventOptionsSchema, data: unknown, options: { topic: string }) => Promise<void> }) => {
                            handlerStarted = true;
                            await sleep(500); // stop() begins meanwhile
                            relayed = ctx.publish(EventOptionsSchema, {}, { topic: outTopic });
                            await relayed;
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        try {
            await createTopicWithLeader(admin, inTopic);
            await createTopicWithLeader(admin, outTopic);
            await publisher.connect({ serviceName: "integration-relay-publisher" });
            await sink.connect({ serviceName: "integration-relay-sink" });
            await sink.subscribe(
                [outTopic],
                async (event, ack) => {
                    received.push(event.eventId);
                    await ack();
                },
                { group: `sink-${id}` },
            );
            await bus.start();

            await publisher.publish(inTopic, new Uint8Array());
            await until(() => handlerStarted, "relay handler start");
            await bus.stop();
            assert.ok(relayed, "the handler must have reached ctx.publish");
            await relayed;

            await until(() => received.length >= 1, "relayed event delivery");
            await sleep(1_000);
            assert.equal(received.length, 1, `the relayed event must be delivered exactly once (got ${received.length})`);

            const [committed] = await admin.fetchOffsets({ groupId: group, topics: [inTopic] });
            const offset = committed?.partitions[0]?.offset;
            assert.equal(offset, "1", `the input offset must be committed past the message (got ${String(offset)})`);
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await admin.deleteTopics({ topics: [inTopic, outTopic] }).catch(() => undefined);
            await admin.disconnect();
        }
    });

    it("a handler that fails while stop() runs is dead-lettered once, the republish is awaited, and the input offset is committed", { timeout: 180_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const inTopic = `it.relay.dlq.in.${id}`;
        const dlqTopic = `it.relay.dlq.out.${id}`;
        const group = `relay-dlq-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayDlqService", methods: [method] } as any;

        const admin = new Kafka({ clientId: "integration-relay-dlq-control", brokers, logLevel: logLevel.ERROR }).admin();
        await admin.connect();
        const newAdapter = () =>
            KafkaAdapter({
                brokers,
                clientId: `integration-relay-dlq-${randomUUID()}`,
                logLevel: "error",
                consumerOptions: { fromBeginning: true, redeliveryDelay: 0 },
            });
        const publisher = newAdapter();
        const sink = newAdapter();
        let handlerStarted = false;
        const dead: Array<ReadonlyMap<string, string>> = [];

        const bus = createEventBus({
            adapter: newAdapter(),
            group,
            drainTimeout: 20_000,
            middleware: { dlq: { topic: dlqTopic } },
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async () => {
                            handlerStarted = true;
                            await sleep(500); // stop() begins meanwhile
                            throw new Error("handler failed during shutdown");
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        try {
            await createTopicWithLeader(admin, inTopic);
            await createTopicWithLeader(admin, dlqTopic);
            await publisher.connect({ serviceName: "integration-relay-dlq-publisher" });
            await sink.connect({ serviceName: "integration-relay-dlq-sink" });
            await sink.subscribe(
                [dlqTopic],
                async (event, ack) => {
                    dead.push(event.metadata);
                    await ack();
                },
                { group: `sink-${id}` },
            );
            await bus.start();

            await publisher.publish(inTopic, new Uint8Array());
            await until(() => handlerStarted, "failing handler start");
            await bus.stop();

            await until(() => dead.length >= 1, "dead-letter delivery");
            await sleep(1_000);
            assert.equal(dead.length, 1, `the failed event must be dead-lettered exactly once (got ${dead.length})`);
            assert.equal(dead[0]?.get("dlq.original-topic"), inTopic);

            const [committed] = await admin.fetchOffsets({ groupId: group, topics: [inTopic] });
            const offset = committed?.partitions[0]?.offset;
            assert.equal(offset, "1", `the failed input offset must be committed after the dead-letter publish (got ${String(offset)})`);
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await admin.deleteTopics({ topics: [inTopic, dlqTopic] }).catch(() => undefined);
            await admin.disconnect();
        }
    });
});
