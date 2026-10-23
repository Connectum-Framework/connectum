/**
 * The shutdown signal ends reception, against a real RabbitMQ: when the signal given to the bus
 * aborts, a handler that is running finishes and acknowledges its message, a message that arrives
 * after the abort is not handled by that bus, and the next consumer of the group receives it
 * exactly once. The queue ends with no message and no unacknowledged delivery.
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

/** Holds the first handler until the test lets it go, so it provably runs across the abort. */
function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

describe("EventBus reception after the shutdown signal aborts on RabbitMQ", { skip: AMQP_URL === undefined ? "AMQP_TEST_URL not set" : false, concurrency: 1 }, () => {
    const url = AMQP_URL as string;

    it("a running handler finishes, a message that arrives after the abort goes to the next consumer exactly once, and the queue ends empty", { timeout: 60_000 }, async () => {
        const id = randomUUID().slice(0, 8);
        const exchange = `abort.reception.${id}`;
        const topic = `abort.in.${id}`;
        const group = `abort-${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: topic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.AbortReceptionService", methods: [method] } as any;

        const newAdapter = () => AmqpAdapter({ url, exchange, exchangeType: "topic", recovery: false });
        const publisher = newAdapter();
        const raw = await connect(url);
        const rawChannel = await raw.createChannel();

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
            await publisher.connect();
            await first.start({ signal: controller.signal });

            await publisher.publish(topic, new Uint8Array());
            await waitFor(() => handledByFirst.length === 1, "first handler start");

            controller.abort();
            await publisher.publish(topic, new Uint8Array());
            firstGate.release();

            await sleep(800);
            assert.equal(handledByFirst.length, 1, `the bus must not handle a message that arrives after the abort (handled ${handledByFirst.length})`);

            await first.stop();
            await second.start();
            await waitFor(() => handledBySecond.length >= 1, "next consumer delivery");
            await sleep(500);
            assert.equal(handledBySecond.length, 1, `the next consumer must receive the message exactly once (got ${handledBySecond.length})`);

            const queue = await rawChannel.checkQueue(`${exchange}.${group}`);
            assert.equal(queue.messageCount, 0, "no message may be left in the queue");
        } finally {
            firstGate.release();
            await first.stop().catch(() => undefined);
            await second.stop().catch(() => undefined);
            await publisher.disconnect().catch(() => undefined);
            await rawChannel.deleteQueue(`${exchange}.${group}`).catch(() => undefined);
            await rawChannel.deleteExchange(exchange).catch(() => undefined);
            await rawChannel.close().catch(() => undefined);
            await raw.close().catch(() => undefined);
        }
    });
});
