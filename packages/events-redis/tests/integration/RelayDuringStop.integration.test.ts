/**
 * A relay handler (consume, publish another event) that is still running when `EventBus.stop()`
 * begins, against a real Redis: its `ctx.publish` reaches the broker before the adapter is
 * disconnected, the input entry is acknowledged (nothing stays pending for the group), and the
 * relayed event is delivered exactly once.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { Redis } from "ioredis";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    }
}

describe("EventBus relay during stop() on Redis", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    it("a handler that relays through ctx.publish while stop() runs delivers the relayed event once and leaves nothing pending", { timeout: 60_000 }, async () => {
        const inTopic = `it.relay.in.${randomUUID().replaceAll("-", "")}`;
        const outTopic = `it.relay.out.${randomUUID().replaceAll("-", "")}`;
        const group = `relay-${randomUUID()}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayService", methods: [method] } as any;

        const newAdapter = () => RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 5 } });
        const publisher = newAdapter();
        const sink = newAdapter();
        const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

        let handlerStarted = false;
        let relayed: Promise<void> | undefined;
        const received: string[] = [];

        const bus = createEventBus({
            adapter: newAdapter(),
            group,
            drainTimeout: 10_000,
            routes: [
                (router) => {
                    router.service(service, {
                        simpleEvent: async (_message: unknown, ctx: { publish: (schema: typeof EventOptionsSchema, data: unknown, options: { topic: string }) => Promise<void> }) => {
                            handlerStarted = true;
                            await new Promise((resolve) => globalThis.setTimeout(resolve, 400)); // stop() begins meanwhile
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
            const sinkSubscription = await sink.subscribe([outTopic], async (event, ack) => {
                received.push(event.eventId);
                await ack();
            }, { group: `sink-${randomUUID()}` });
            await bus.start();

            await publisher.publish(inTopic, new Uint8Array());
            await until(() => handlerStarted, "relay handler start");
            await bus.stop();
            assert.ok(relayed, "the handler must have reached ctx.publish");
            await relayed;

            await until(() => received.length >= 1, "relayed event delivery");
            await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
            assert.equal(received.length, 1, `the relayed event must be delivered exactly once (got ${received.length})`);

            const pending = (await control.xpending(`events:${inTopic}`, group)) as [number, ...unknown[]];
            assert.equal(pending[0], 0, "the input entry must have been acknowledged during the shutdown");
            await sinkSubscription.unsubscribe();
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await control.quit().catch(() => undefined);
        }
    });

    it("a handler that fails while stop() runs is dead-lettered once, the republish is awaited, and the input entry is acknowledged", { timeout: 60_000 }, async () => {
        const inTopic = `it.relay.dlq.in.${randomUUID().replaceAll("-", "")}`;
        const dlqTopic = `it.relay.dlq.out.${randomUUID().replaceAll("-", "")}`;
        const group = `relay-dlq-${randomUUID()}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: inTopic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RelayDlqService", methods: [method] } as any;

        const newAdapter = () => RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 5 } });
        const publisher = newAdapter();
        const sink = newAdapter();
        const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

        let handlerStarted = false;
        const dead: Array<ReadonlyMap<string, string>> = [];

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
                            await new Promise((resolve) => globalThis.setTimeout(resolve, 400)); // stop() begins meanwhile
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
            const sinkSubscription = await sink.subscribe(
                [dlqTopic],
                async (event, ack) => {
                    dead.push(event.metadata);
                    await ack();
                },
                { group: `sink-${randomUUID()}` },
            );
            await bus.start();

            await publisher.publish(inTopic, new Uint8Array());
            await until(() => handlerStarted, "failing handler start");
            await bus.stop();

            await until(() => dead.length >= 1, "dead-letter delivery");
            await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
            assert.equal(dead.length, 1, `the failed event must be dead-lettered exactly once (got ${dead.length})`);
            assert.equal(dead[0]?.get("dlq.original-topic"), inTopic);

            const pending = (await control.xpending(`events:${inTopic}`, group)) as [number, ...unknown[]];
            assert.equal(pending[0], 0, "the failed input entry must have been acknowledged after the dead-letter publish");
            await sinkSubscription.unsubscribe();
        } finally {
            await publisher.disconnect().catch(() => undefined);
            await sink.disconnect().catch(() => undefined);
            await control.quit().catch(() => undefined);
        }
    });
});
