/**
 * Metadata given to publish() reaches the handler on NATS as it was given, except for the one key
 * the adapter owns.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name connectum-nats-test -p 4222:4222 nats:2.11-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/MetadataRoundTrip.integration.test.ts
 *
 * The Redis and in-memory adapters hand every key to the handler. A NATS adapter that dropped keys
 * starting with `x-` and empty values made a handler that reads `x-request-id` work on one adapter
 * and see nothing on another.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("NATS adapter: metadata round trip", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const servers = NATS_TEST_URL as string;

    it("delivers x-* keys and empty values, and keeps the event id the adapter generated", { timeout: 60_000 }, async () => {
        const stream = `md${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const adapter = NatsAdapter({ servers, stream });
        await adapter.connect();
        try {
            let received: Map<string, string> | undefined;
            let eventId: string | undefined;
            await adapter.subscribe(
                ["md.t"],
                async (event, ack) => {
                    received = event.metadata;
                    eventId = event.eventId;
                    await ack();
                },
                { group: "g" },
            );
            await adapter.publish("md.t", new Uint8Array(1), {
                metadata: {
                    plain: "v",
                    "X-Upper": "U",
                    "x-lower": "kept",
                    "x-request-id": "req-1",
                    "x-published-at": "kept-too",
                    "x-event-id": "spoof",
                    "Mixed-Case": "M",
                    empty: "",
                    "with-uni": "😀é漢",
                },
            });
            const deadline = Date.now() + 15_000;
            while (received === undefined && Date.now() < deadline) {
                await sleep(25);
            }
            assert.ok(received, "the handler received the event");
            assert.deepEqual(Object.fromEntries(received), {
                plain: "v",
                "X-Upper": "U",
                "x-lower": "kept",
                "x-request-id": "req-1",
                "x-published-at": "kept-too",
                "Mixed-Case": "M",
                empty: "",
                "with-uni": "😀é漢",
            });
            assert.notEqual(eventId, "spoof", "a caller cannot choose the event id");
            assert.match(eventId ?? "", /^[0-9a-f-]{36}$/, "the event id is the one the adapter generated");
        } finally {
            await adapter.disconnect();
        }
    });
});
