/**
 * The shutdown signal ends reception, against a real NATS JetStream server: when the signal given
 * to the bus aborts, a handler that is running finishes and acknowledges its message, a message
 * that arrives after the abort is not handled by that bus, and the next consumer of the group
 * receives it exactly once. The durable consumer ends with nothing awaiting an acknowledgement.
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
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { consumerName, NatsAdapter } from "../../src/NatsAdapter.ts";

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

/** Holds the first handler until the test lets it go, so it provably runs across the abort. */
function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

describe("EventBus reception after the shutdown signal aborts on NATS", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("a running handler finishes, a message that arrives after the abort goes to the next consumer exactly once, and the consumer ends settled", { timeout: 120_000 }, async () => {
        const id = randomUUID().replaceAll("-", "");
        const topic = `it.abort.in.${id}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: topic, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.AbortReceptionService", methods: [method] } as any;

        const stream = `itabort${id.slice(0, 12)}`;
        const group = `abort-${id}`;
        const publisher = NatsAdapter({ servers, stream });
        const firstGate = gate();
        const handledByFirst: string[] = [];
        const handledBySecond: string[] = [];
        const controller = new AbortController();

        const newBus = (handled: string[], onFirst?: () => Promise<void>) =>
            createEventBus({
                adapter: NatsAdapter({ servers, stream }),
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

            await sleep(800);
            assert.equal(handledByFirst.length, 1, `the bus must not handle a message that arrives after the abort (handled ${handledByFirst.length})`);

            await first.stop();
            await second.start();
            await until(() => handledBySecond.length >= 1, "next consumer delivery");
            await sleep(500);
            assert.equal(handledBySecond.length, 1, `the next consumer must receive the message exactly once (got ${handledBySecond.length})`);
            await second.stop();

            const connection = await connect({ servers });
            try {
                const manager = await jetstreamManager(connection);
                const info = await manager.consumers.info(stream, consumerName(group, topic));
                assert.equal(info.num_ack_pending, 0, "no message may wait for an acknowledgement");
                assert.equal(info.num_pending, 0, "no message may be left for the group to deliver");
            } finally {
                await connection.close();
            }
        } finally {
            firstGate.release();
            await first.stop().catch(() => undefined);
            await second.stop().catch(() => undefined);
            await publisher.disconnect().catch(() => undefined);
        }
    });
});
