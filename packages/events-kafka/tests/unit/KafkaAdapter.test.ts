import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

describe("KafkaAdapter", () => {
    it("creates adapter with correct name", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        assert.equal(adapter.name, "kafka");
    });

    it("creates adapter with custom clientId", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            clientId: "my-service",
        });

        assert.equal(adapter.name, "kafka");
    });

    it("throws when publishing without connection", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        await assert.rejects(
            () => adapter.publish("test.topic", new Uint8Array([1, 2, 3])),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("throws when subscribing without connection", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        await assert.rejects(
            () =>
                adapter.subscribe(["test.topic"], async () => {
                    // no-op handler
                }),
            { message: "KafkaAdapter: not connected" },
        );
    });

    it("accepts multiple brokers", () => {
        const adapter = KafkaAdapter({
            brokers: ["broker1:9092", "broker2:9092", "broker3:9092"],
        });

        assert.equal(adapter.name, "kafka");
    });

    it("accepts producer options", () => {
        // CompressionTypes.GZIP = 1
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            producerOptions: {
                compression: 1,
            },
        });

        assert.equal(adapter.name, "kafka");
    });

    it("accepts consumer options", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            consumerOptions: {
                sessionTimeout: 60000,
                fromBeginning: true,
            },
        });

        assert.equal(adapter.name, "kafka");
    });

    it("has all required EventAdapter methods", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        assert.equal(typeof adapter.connect, "function");
        assert.equal(typeof adapter.disconnect, "function");
        assert.equal(typeof adapter.publish, "function");
        assert.equal(typeof adapter.subscribe, "function");
        assert.equal(typeof adapter.name, "string");
    });

    it("disconnect is safe to call without connect", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        // Should not throw
        await adapter.disconnect();
    });
});
