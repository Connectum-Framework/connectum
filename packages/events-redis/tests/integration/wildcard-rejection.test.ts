/**
 * Wildcard subscriptions are rejected by the Redis adapter, against a real broker.
 *
 * Set REDIS_TEST_URL to a Redis 6.2+ or Valkey endpoint. Redis Streams has no pattern
 * subscription, so a wildcard route must fail loudly when the subscription is made,
 * not silently receive nothing.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

describe("Redis adapter wildcard rejection", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    it("subscribe() rejects `*` and `>` patterns with the documented message", async () => {
        const adapter = RedisAdapter({ url });
        await adapter.connect({ serviceName: "integration-wildcard-rejection" });
        try {
            for (const pattern of ["orders.*", "orders.>"]) {
                await assert.rejects(adapter.subscribe([`plain.${randomUUID()}`, pattern], async () => undefined, { group: `g-${randomUUID()}` }), {
                    message: `RedisAdapter: wildcard pattern "${pattern}" is not supported. Redis Streams requires explicit topic names.`,
                });
            }
        } finally {
            await adapter.disconnect();
        }
    });

    it("EventBus.start() fails with the adapter's message when a route's topic is a wildcard", async () => {
        const eventType = `it.wild.${randomUUID().replaceAll("-", "")}.*`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: eventType, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "wildEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.WildService", methods: [method] } as any;

        const bus = createEventBus({
            adapter: RedisAdapter({ url }),
            group: `g-${randomUUID()}`,
            routes: [
                (router) => {
                    router.service(service, {
                        wildEvent: async () => undefined,
                        // biome-ignore lint/suspicious/noExplicitAny: route map against a fake descriptor
                    } as any);
                },
            ],
        });

        await assert.rejects(bus.start(), { message: `RedisAdapter: wildcard pattern "${eventType}" is not supported. Redis Streams requires explicit topic names.` });
        await bus.stop();
    });
});
