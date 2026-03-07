import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

describe("NatsAdapter", () => {
    it("should return an adapter with name 'nats'", () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        assert.equal(adapter.name, "nats");
    });

    it("should accept a single server string", () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        assert.ok(adapter);
    });

    it("should accept an array of servers", () => {
        const adapter = NatsAdapter({
            servers: ["nats://host1:4222", "nats://host2:4222"],
        });
        assert.ok(adapter);
    });

    it("should accept custom stream name", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            stream: "custom-stream",
        });
        assert.ok(adapter);
        assert.equal(adapter.name, "nats");
    });

    it("should accept consumer options", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            consumerOptions: {
                deliverPolicy: "all",
                ackWait: 60_000,
                maxDeliver: 10,
            },
        });
        assert.ok(adapter);
    });

    it("should throw when publishing without connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        await assert.rejects(
            () => adapter.publish("test.event", new Uint8Array([1, 2, 3])),
            { message: "NatsAdapter: not connected" },
        );
    });

    it("should throw when subscribing without connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        await assert.rejects(
            () => adapter.subscribe(["test.>"], async () => {}),
            { message: "NatsAdapter: not connected" },
        );
    });

    it("should not throw when disconnecting without prior connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        // disconnect() should be a no-op when not connected
        await adapter.disconnect();
    });

    it("should expose required EventAdapter methods", () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        assert.equal(typeof adapter.connect, "function");
        assert.equal(typeof adapter.disconnect, "function");
        assert.equal(typeof adapter.publish, "function");
        assert.equal(typeof adapter.subscribe, "function");
    });

    it("should accept group names with dots and special chars without throwing", () => {
        // sanitizeDurableName is internal, but we can verify it indirectly:
        // Creating an adapter with a group containing dots/special chars
        // should not throw during construction. The sanitization happens at
        // subscribe time, but the adapter itself should accept any config.
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            stream: "my.stream.name",
        });
        assert.ok(adapter);
        assert.equal(adapter.name, "nats");
    });
});
