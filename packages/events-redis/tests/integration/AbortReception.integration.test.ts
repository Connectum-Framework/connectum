/**
 * The shutdown signal ends reception, against a real Redis: when the signal given to the bus
 * aborts, a handler that is running finishes and acknowledges its entry, an entry that arrives
 * after the abort is not handled by that bus, and the next consumer of the group receives it
 * exactly once. Nothing stays pending for the group.
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

/** Holds the first handler until the test lets it go, so it provably runs across the abort. */
function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

describe("EventBus reception after the shutdown signal aborts on Redis", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = REDIS_TEST_URL as string;

    it("a running handler finishes, an entry that arrives after the abort goes to the next consumer exactly once, and nothing stays pending", { timeout: 60_000 }, async () => {
        const topic = `it.abort.in.${randomUUID().replaceAll("-", "")}`;
        const group = `abort-${randomUUID()}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: topic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.AbortReceptionService", methods: [method] } as any;

        const newAdapter = () => RedisAdapter({ url, brokerOptions: { blockMs: 20, count: 5 } });
        const publisher = newAdapter();
        const control = new Redis(url, { protocol: 2, replyMapping: "legacy" });

        const firstGate = gate();
        const handledByFirst: string[] = [];
        const handledBySecond: string[] = [];
        const controller = new AbortController();

        const newBus = (handled: string[], onFirst?: () => Promise<void>) =>
            createEventBus({
                adapter: newAdapter(),
                group,
                drainTimeout: 10_000,
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
            await publisher.connect({ serviceName: "integration-abort-publisher" });
            await first.start({ signal: controller.signal });

            await publisher.publish(topic, new Uint8Array());
            await until(() => handledByFirst.length === 1, "first handler start");

            controller.abort();
            await publisher.publish(topic, new Uint8Array());
            firstGate.release();

            await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
            assert.equal(handledByFirst.length, 1, `the bus must not handle an entry that arrives after the abort (handled ${handledByFirst.length})`);

            await first.stop();
            await second.start();
            await until(() => handledBySecond.length >= 1, "next consumer delivery");
            await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
            assert.equal(handledBySecond.length, 1, `the next consumer must receive the entry exactly once (got ${handledBySecond.length})`);

            const pending = (await control.xpending(`events:${topic}`, group)) as [number, ...unknown[]];
            assert.equal(pending[0], 0, "both entries must have been acknowledged");
        } finally {
            firstGate.release();
            await first.stop().catch(() => undefined);
            await second.stop().catch(() => undefined);
            await publisher.disconnect().catch(() => undefined);
            await control.quit().catch(() => undefined);
        }
    });
});
