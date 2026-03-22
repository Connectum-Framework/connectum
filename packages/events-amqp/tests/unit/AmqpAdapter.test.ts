import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmqpAdapter, toAmqpPattern } from "../../src/AmqpAdapter.ts";

describe("AmqpAdapter", () => {
    it("should return an adapter with name 'amqp'", () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        assert.equal(adapter.name, "amqp");
    });

    it("should accept a URL string", () => {
        const adapter = AmqpAdapter({ url: "amqp://guest:guest@localhost:5672" });
        assert.ok(adapter);
    });

    it("should accept custom exchange name", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            exchange: "custom.exchange",
        });
        assert.ok(adapter);
        assert.equal(adapter.name, "amqp");
    });

    it("should accept exchange options", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            exchangeType: "direct",
            exchangeOptions: {
                durable: false,
                autoDelete: true,
            },
        });
        assert.ok(adapter);
    });

    it("should accept queue options", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            queueOptions: {
                durable: true,
                messageTtl: 60_000,
                maxLength: 10_000,
                deadLetterExchange: "dlx.exchange",
                deadLetterRoutingKey: "dlq",
            },
        });
        assert.ok(adapter);
    });

    it("should accept consumer options", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            consumerOptions: {
                prefetch: 20,
                exclusive: true,
            },
        });
        assert.ok(adapter);
    });

    it("should accept publisher options", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            publisherOptions: {
                persistent: false,
                mandatory: true,
            },
        });
        assert.ok(adapter);
    });

    it("should accept all options together without TypeError", () => {
        const adapter = AmqpAdapter({
            url: "amqp://guest:guest@localhost:5672",
            socketOptions: { timeout: 5000 },
            exchange: "test.events",
            exchangeType: "topic",
            exchangeOptions: { durable: true, autoDelete: false },
            queueOptions: {
                durable: true,
                messageTtl: 30_000,
                maxLength: 5000,
                deadLetterExchange: "dlx",
                deadLetterRoutingKey: "dlq.key",
            },
            consumerOptions: { prefetch: 5, exclusive: false },
            publisherOptions: { persistent: true, mandatory: false },
        });
        assert.ok(adapter);
        assert.equal(adapter.name, "amqp");
    });

    it("should throw when publishing without connection", async () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        await assert.rejects(
            () => adapter.publish("test.event", new Uint8Array([1, 2, 3])),
            { message: "AmqpAdapter: not connected" },
        );
    });

    it("should throw when subscribing without connection", async () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        await assert.rejects(
            () => adapter.subscribe(["test.>"], async () => {}),
            { message: "AmqpAdapter: not connected" },
        );
    });

    it("should not throw when disconnecting without prior connection", async () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        // disconnect() should be a no-op when not connected
        await adapter.disconnect();
    });

    it("should expose required EventAdapter methods", () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        assert.equal(typeof adapter.connect, "function");
        assert.equal(typeof adapter.disconnect, "function");
        assert.equal(typeof adapter.publish, "function");
        assert.equal(typeof adapter.subscribe, "function");
    });
});

describe("AmqpAdapter AdapterContext", () => {
    it("connect() accepts AdapterContext parameter", () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });

        // connect() should accept an optional AdapterContext
        assert.equal(typeof adapter.connect, "function");
    });

    it("connect() accepts AdapterContext without TypeError", async () => {
        const adapter = AmqpAdapter({ url: "amqp://invalid-host:5672" });

        // connect() will fail (no broker), but should accept the context
        // without throwing TypeError. The serviceName is mapped to
        // clientProperties.connection_name.
        await assert.rejects(
            () => adapter.connect({ serviceName: "order.v1@test-host" }),
            (err: Error) => {
                assert.ok(
                    !(err instanceof TypeError),
                    "Should not throw TypeError for AdapterContext",
                );
                return true;
            },
        );
    });

    it("connect() works with undefined context (backward compat)", async () => {
        const adapter = AmqpAdapter({ url: "amqp://invalid-host:5672" });

        // Calling connect() without context should still work (minus broker availability)
        await assert.rejects(
            () => adapter.connect(),
            (err: Error) => {
                assert.ok(
                    !(err instanceof TypeError),
                    "Should not throw TypeError for missing context",
                );
                return true;
            },
        );
    });
});

describe("toAmqpPattern", () => {
    it("should convert > to # for multi-level wildcard", () => {
        assert.equal(toAmqpPattern("user.>"), "user.#");
    });

    it("should preserve * for single-level wildcard", () => {
        assert.equal(toAmqpPattern("user.*"), "user.*");
    });

    it("should convert multiple > occurrences", () => {
        assert.equal(toAmqpPattern(">.user.>"), "#.user.#");
    });

    it("should return literal patterns unchanged", () => {
        assert.equal(toAmqpPattern("user.created"), "user.created");
    });

    it("should handle mixed wildcards", () => {
        assert.equal(toAmqpPattern("*.user.>"), "*.user.#");
    });

    it("should handle empty string", () => {
        assert.equal(toAmqpPattern(""), "");
    });

    it("should handle pattern with only >", () => {
        assert.equal(toAmqpPattern(">"), "#");
    });
});
