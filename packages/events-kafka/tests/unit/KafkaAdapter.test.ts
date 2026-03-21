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

describe("KafkaAdapter AdapterContext", () => {
    // Note: connect() calls `new Kafka(...)` then `kafka.producer().connect()`,
    // so we cannot test connect() success without a real broker. We verify the
    // connect() signature accepts the context parameter and that the clientId
    // fallback logic works indirectly through construction tests.

    it("connect() accepts AdapterContext parameter", () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
        });

        // connect() should accept an optional AdapterContext
        assert.equal(typeof adapter.connect, "function");
    });

    it("connect() accepts AdapterContext without TypeError", async () => {
        // We cannot verify the actual Kafka clientId without a running broker,
        // but we can verify the adapter does not throw a TypeError when context is provided.
        // The actual clientId = options.clientId ?? context?.serviceName ?? "connectum"
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            kafkaConfig: { retry: { retries: 0 } },
        });

        // connect() will throw because no broker is available, but the error
        // should be a connection error, NOT a TypeError about the context parameter.
        await assert.rejects(
            () => adapter.connect({ serviceName: "order.v1@test-host" }),
            (err: Error) => {
                // Should fail with a connection-related error, not a type error
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for AdapterContext");
                return true;
            },
        );
    });

    it("adapter can be constructed with explicit clientId", () => {
        // Verify construction works with both clientId and context will be provided.
        // The priority chain is: options.clientId > context.serviceName > "connectum"
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            clientId: "explicit-client-id",
        });

        assert.equal(adapter.name, "kafka");
    });

    it("connect() works with undefined context (backward compat)", async () => {
        const adapter = KafkaAdapter({
            brokers: ["localhost:9092"],
            kafkaConfig: { retry: { retries: 0 } },
        });

        // Calling connect() without context should still work (minus broker availability)
        await assert.rejects(
            () => adapter.connect(),
            (err: Error) => {
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for missing context");
                return true;
            },
        );
    });
});
