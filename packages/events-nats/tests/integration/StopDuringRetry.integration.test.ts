/**
 * An event that waits between retries when the bus stops goes back to NATS, not to the DLQ.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/StopDuringRetry.integration.test.ts
 *
 * The first bus fails the event once and starts a long retry pause; `stop()` ends the pause at
 * `drainTimeout`. The dead-letter topic must stay empty, and a second bus of the same group must
 * receive the event again (JetStream counts the redelivery: `attempt` is 2).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@connectum/events";
import { EventOptionsSchema } from "@connectum/events/gen/connectum/events/v1/options_pb.js";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`${label} did not happen within ${timeoutMs}ms`);
        }
        await sleep(25);
    }
}

describe("EventBus.stop() during a retry pause on NATS", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("leaves the DLQ empty and lets the next bus of the group handle the event", { timeout: 120_000 }, async () => {
        const unique = randomUUID().replaceAll("-", "");
        const eventType = `it.retrystop.${unique}`;
        const dlqTopic = `it.retrystop.dlq.${unique}`;
        const stream = `itretrystop${unique.slice(0, 12)}`;
        const group = `retrystop-${unique}`;
        const input = Object.create(EventOptionsSchema, { typeName: { value: eventType, enumerable: true } });
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const method = { localName: "simpleEvent", input, proto: { options: undefined } } as any;
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake descriptor for route registration
        const service = { typeName: "integration.v1.RetryStopService", methods: [method] } as any;
        const route = (handler: (message: unknown, ctx: { attempt: number }) => Promise<void>) => (router: { service: (descriptor: unknown, handlers: unknown) => void }) => {
            router.service(service, { simpleEvent: handler });
        };

        const publisher = NatsAdapter({ servers, stream });
        const dlqReader = NatsAdapter({ servers, stream });
        const deadLettered: string[] = [];

        let firstBusCalls = 0;
        const firstBus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            group,
            drainTimeout: 300,
            middleware: { retry: { maxRetries: 3, backoff: "fixed", initialDelay: 60_000 }, dlq: { topic: dlqTopic } },
            // biome-ignore lint/suspicious/noExplicitAny: route against a fake descriptor
            routes: [route(async () => { firstBusCalls += 1; throw new Error("transient failure"); }) as any],
        });

        const redelivered: number[] = [];
        const secondBus = createEventBus({
            adapter: NatsAdapter({ servers, stream }),
            group,
            // biome-ignore lint/suspicious/noExplicitAny: route against a fake descriptor
            routes: [route(async (_message, ctx) => { redelivered.push(ctx.attempt); }) as any],
        });

        await publisher.connect({ serviceName: "integration-retrystop-publisher" });
        await dlqReader.connect({ serviceName: "integration-retrystop-dlq" });
        let secondStarted = false;
        try {
            await dlqReader.subscribe(
                [dlqTopic],
                async (event, ack) => {
                    deadLettered.push(event.metadata.get("dlq.error") ?? "");
                    await ack();
                },
                { group: `dlq-${unique}` },
            );
            await firstBus.start();
            await publisher.publish(eventType, new Uint8Array());
            await until(() => firstBusCalls === 1, "first attempt", 30_000);

            await firstBus.stop();
            await sleep(500);

            assert.equal(firstBusCalls, 1, "the retry never ran");
            assert.deepEqual(deadLettered, [], "a stop must not dead-letter the event that waited for its retry");

            await secondBus.start();
            secondStarted = true;
            await until(() => redelivered.length > 0, "redelivery to the next bus", 30_000);
            assert.deepEqual(redelivered, [2], "the next bus handles the event as the second JetStream delivery");
        } finally {
            if (secondStarted) {
                await secondBus.stop();
            }
            await dlqReader.disconnect();
            await publisher.disconnect();
        }
    });
});
