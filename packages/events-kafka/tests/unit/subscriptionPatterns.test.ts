import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

// An adapter that was never connected has no broker to reach: a rejection naming the pattern (and
// not "not connected") proves the pattern was refused before the adapter touched the broker.
describe("KafkaAdapter subscription patterns", () => {
    for (const pattern of ["", ".", ".."]) {
        it(`rejects ${JSON.stringify(pattern)}, a topic name Kafka reserves, before reaching the broker`, async () => {
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

            await assert.rejects(
                adapter.subscribe(["pay.created", pattern], async () => undefined, { group: "g" }),
                (error: unknown) => error instanceof TypeError && error.message === `KafkaAdapter: subscription pattern "${pattern}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`,
            );
        });
    }

    it("accepts topic names with an empty segment, which Kafka allows", async () => {
        for (const pattern of ["a..b", ".a", "a.", "..."]) {
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

            await assert.rejects(
                adapter.subscribe([pattern], async () => undefined),
                { message: "KafkaAdapter: not connected" },
                pattern,
            );
        }
    });

    it("accepts literal, single-segment wildcard and tail wildcard patterns", async () => {
        for (const pattern of ["a.b", "a.*", "a.>", ">"]) {
            const adapter = KafkaAdapter({ brokers: ["localhost:9092"] });

            await assert.rejects(
                adapter.subscribe([pattern], async () => undefined),
                { message: "KafkaAdapter: not connected" },
                pattern,
            );
        }
    });
});
