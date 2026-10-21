import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

// An adapter that was never connected has no broker to reach: a rejection naming the pattern (and
// not "not connected") proves the pattern was refused before the adapter touched the broker.
describe("NatsAdapter subscription patterns", () => {
    for (const [label, pattern] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`rejects ${label} before reaching the broker`, async () => {
            const adapter = NatsAdapter({ servers: "nats://localhost:4222" });

            await assert.rejects(
                adapter.subscribe(["pay.created", pattern], async () => undefined, { group: "g" }),
                (error: unknown) => error instanceof TypeError && error.message.startsWith(`NatsAdapter: subscription pattern "${pattern}" has an empty segment (`),
            );
        });
    }

    it("accepts literal, single-segment wildcard and tail wildcard patterns", async () => {
        for (const pattern of ["a.b", "a.*", "a.>", ">"]) {
            const adapter = NatsAdapter({ servers: "nats://localhost:4222" });

            await assert.rejects(
                adapter.subscribe([pattern], async () => undefined),
                { message: "NatsAdapter: not connected" },
                pattern,
            );
        }
    });
});

// The same proof for publishing: on an adapter that was never connected, the topic error (and not
// "not connected") shows the topic was refused before the adapter touched the broker.
describe("NatsAdapter publish topics", () => {
    for (const [label, topic] of [
        ["the empty string", ""],
        ["an empty segment between dots", "a..b"],
        ["a leading dot", ".a"],
        ["a trailing dot", "a."],
        ["a lone dot", "."],
    ] as const) {
        it(`rejects ${label} before reaching the broker`, async () => {
            const adapter = NatsAdapter({ servers: "nats://localhost:4222" });

            await assert.rejects(
                adapter.publish(topic, new Uint8Array([1])),
                (error: unknown) => error instanceof TypeError && error.message.startsWith(`NatsAdapter: publish topic "${topic}" has an empty segment (`),
            );
        });
    }

    it("reaches the connection check with a well-formed topic", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });

        await assert.rejects(adapter.publish("a.b", new Uint8Array([1])), { message: "NatsAdapter: not connected" });
    });
});
