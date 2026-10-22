/**
 * A relay handler (consume, publish another event) that is still running when `EventBus.stop()`
 * begins, against a real RabbitMQ: its `ctx.publish` reaches the broker before the adapter is
 * disconnected, the input message is acknowledged (it is not delivered again to another consumer
 * of the group) and the relayed event is delivered exactly once.
 *
 * Skipped unless AMQP_TEST_URL is set (see amqp-broker.test.ts for starting a broker).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { connect } from "amqplib";
import { AmqpAdapter } from "../../src/AmqpAdapter.ts";

const AMQP_URL = process.env.AMQP_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(25);
    }
}

describe("EventBus relay during stop() on RabbitMQ", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    it("a handler that relays through ctx.publish while stop() runs delivers the relayed event once and the input is not redelivered", { timeout: 60_000 }, async () => {
        const id = randomUUID().slice(0, 8);
        const exchange = `relay.stop.${id}`;
        const inTopic = `relay.in.${id}`;
        const outTopic = `relay.out.${id}`;
        const group = `relay-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayService", methods: [method] } as any;

        const newAdapter = () => AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        const publisher = newAdapter();
        const sink = newAdapter();
        const raw = await connect(url);
        const rawChannel = await raw.createChannel();

        let handlerStarted = false;
        let relayed: Promise<void> | undefined;
        const received: string[] = [];
        const again: string[] = [];

        const bus = createEventBus({
            adapter: newAdapter(),
            group,
            drainTimeout: 10_000,
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async (_message: unknown, ctx: { publish: (schema: typeof EventOptionsSchema, data: unknown, options: { topic: string }) => Promise<void> }) => {
                            handlerStarted = true;
                            await sleep(400); // stop() begins meanwhile
                            relayed = ctx.publish(EventOptionsSchema, {}, { topic: outTopic });
                            await relayed;
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        try {
            await publisher.connect();
            await sink.connect();
            await sink.subscribe(
                [outTopic],
                async (event, ack) => {
                    received.push(event.eventId);
                    await ack();
                },
                { group: `sink-${id}` },
            );
            await bus.start();
            // A second raw consumer on the input queue receives the message again if the broker took it back.
            await rawChannel.consume(`${exchange}.${group}`, (msg) => {
                if (msg !== null) {
                    again.push(msg.fields.redelivered ? "redelivered" : "first");
                    rawChannel.nack(msg, false, false);
                }
            });

            await publisher.publish(inTopic, new Uint8Array());
            await waitFor(() => handlerStarted, "relay handler start");
            await bus.stop();
            assert.ok(relayed, "the handler must have reached ctx.publish");
            await relayed;

            await waitFor(() => received.length >= 1, "relayed event delivery");
            await sleep(500);
            assert.equal(received.length, 1, `the relayed event must be delivered exactly once (got ${received.length})`);
            assert.deepEqual(again, [], "the acknowledged input message must not be delivered again");
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await rawChannel.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
            await rawChannel.deleteExchange(exchange).catch(() => undefined);
            await rawChannel.close().catch(() => undefined);
            await raw.close().catch(() => undefined);
        }
    });

    it("a handler that fails while stop() runs is dead-lettered once, the republish is awaited, and the input is not redelivered", { timeout: 60_000 }, async () => {
        const id = randomUUID().slice(0, 8);
        const exchange = `relay.dlq.stop.${id}`;
        const inTopic = `relay.dlq.in.${id}`;
        const dlqTopic = `relay.dlq.out.${id}`;
        const group = `relay-dlq-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayDlqService", methods: [method] } as any;

        const newAdapter = () => AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        const publisher = newAdapter();
        const sink = newAdapter();
        const raw = await connect(url);
        const rawChannel = await raw.createChannel();

        let handlerStarted = false;
        const dead: Array<ReadonlyMap<string, string>> = [];
        const again: string[] = [];

        const bus = createEventBus({
            adapter: newAdapter(),
            group,
            drainTimeout: 10_000,
            middleware: { dlq: { topic: dlqTopic } },
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async () => {
                            handlerStarted = true;
                            await sleep(400); // stop() begins meanwhile
                            throw new Error("handler failed during shutdown");
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        try {
            await publisher.connect();
            await sink.connect();
            await sink.subscribe(
                [dlqTopic],
                async (event, ack) => {
                    dead.push(event.metadata);
                    await ack();
                },
                { group: `sink-${id}` },
            );
            await bus.start();
            // A second raw consumer on the input queue receives the message again if the broker took it back.
            await rawChannel.consume(`${exchange}.${group}`, (msg) => {
                if (msg !== null) {
                    again.push(msg.fields.redelivered ? "redelivered" : "first");
                    rawChannel.nack(msg, false, false);
                }
            });

            await publisher.publish(inTopic, new Uint8Array());
            await waitFor(() => handlerStarted, "failing handler start");
            await bus.stop();

            await waitFor(() => dead.length >= 1, "dead-letter delivery");
            await sleep(500);
            assert.equal(dead.length, 1, `the failed event must be dead-lettered exactly once (got ${dead.length})`);
            assert.equal(dead[0]?.get("dlq.original-topic"), inTopic);
            assert.deepEqual(again, [], "the failed input message must not be delivered again after the dead-letter publish");
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await rawChannel.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
            await rawChannel.deleteExchange(exchange).catch(() => undefined);
            await rawChannel.close().catch(() => undefined);
            await raw.close().catch(() => undefined);
        }
    });
});
