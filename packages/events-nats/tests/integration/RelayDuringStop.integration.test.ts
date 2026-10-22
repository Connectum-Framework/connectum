/**
 * A relay handler (consume, publish another event) that is still running when `EventBus.stop()`
 * begins, against a real NATS JetStream server: its `ctx.publish` reaches the server before the
 * adapter is disconnected, the input message is acknowledged (the consumer has nothing pending and
 * nothing is redelivered) and the relayed event is delivered exactly once.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

async function until(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(25);
    }
}

describe("EventBus relay during stop() on NATS", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("a handler that relays through ctx.publish while stop() runs delivers the relayed event once and the input is not redelivered", { timeout: 120_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const inTopic = `it.relay.in.${id}`;
        const outTopic = `it.relay.out.${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayService", methods: [method] } as any;

        const stream = `itrelay${id.slice(0, 12)}`;
        const group = `relay-${id}`;
        const publisher = NatsAdapter({ servers, stream });
        const sink = NatsAdapter({ servers, stream });
        let handlerStarted = false;
        let deliveries = 0;
        let relayed: Promise<void> | undefined;
        const received: string[] = [];

        const bus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            group,
            drainTimeout: 10_000,
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async (_message: unknown, ctx: { publish: (schema: typeof EventOptionsSchema, data: unknown, options: { topic: string }) => Promise<void> }) => {
                            deliveries++;
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
            await sleep(500);
            assert.equal(received.length, 1, `the relayed event must be delivered exactly once (got ${received.length})`);
            assert.equal(deliveries, 1, "the input message must not be delivered to the handler again");
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
        }
    });

    it("a handler that fails while stop() runs is dead-lettered once, the republish is awaited, and the input is not redelivered", { timeout: 120_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const inTopic = `it.relay.dlq.in.${id}`;
        const dlqTopic = `it.relay.dlq.out.${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayDlqService", methods: [method] } as any;

        const stream = `itrelaydlq${id.slice(0, 12)}`;
        const group = `relay-dlq-${id}`;
        const publisher = NatsAdapter({ servers, stream });
        const sink = NatsAdapter({ servers, stream });
        let handlerStarted = false;
        let deliveries = 0;
        const dead: Array<ReadonlyMap<string, string>> = [];

        const bus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            group,
            drainTimeout: 10_000,
            middleware: { dlq: { topic: dlqTopic } },
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async () => {
                            deliveries++;
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
            await sleep(500);
            assert.equal(dead.length, 1, `the failed event must be dead-lettered exactly once (got ${dead.length})`);
            assert.equal(dead[0]?.get("dlq.original-topic"), inTopic);
            assert.equal(deliveries, 1, "the failed input message must not be delivered to the handler again");
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
        }
    });

    it("a bus without a group relays through ctx.publish while stop() runs and delivers the relayed event once", { timeout: 120_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const inTopic = `it.relay.nogroup.in.${id}`;
        const outTopic = `it.relay.nogroup.out.${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayNoGroupService", methods: [method] } as any;

        const stream = `itrelayng${id.slice(0, 12)}`;
        const publisher = NatsAdapter({ servers, stream });
        const sink = NatsAdapter({ servers, stream });
        let handlerStarted = false;
        let deliveries = 0;
        let relayed: Promise<void> | undefined;
        const received: string[] = [];

        const bus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            drainTimeout: 10_000,
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async (_message: unknown, ctx: { publish: (schema: typeof EventOptionsSchema, data: unknown, options: { topic: string }) => Promise<void> }) => {
                            deliveries++;
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
            await sleep(500);
            assert.equal(received.length, 1, `the relayed event must be delivered exactly once (got ${received.length})`);
            assert.equal(deliveries, 1, "the input message must not be delivered to the handler again");
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
        }
    });
});
