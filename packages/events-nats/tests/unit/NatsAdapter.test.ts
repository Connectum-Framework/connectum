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

describe("NatsAdapter internal utilities (indirect testing)", () => {
    // -----------------------------------------------------------------------
    // toDeliverPolicy() — private, maps "all"|"last"|undefined → DeliverPolicy
    //
    // This function is called inside subscribe() when creating a durable
    // consumer. Because subscribe() requires a live NATS broker, we cannot
    // invoke it in unit tests. We verify indirectly that the adapter accepts
    // all three deliver policy values without construction errors.
    // -----------------------------------------------------------------------

    it("should accept deliverPolicy 'all' without construction error", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            consumerOptions: { deliverPolicy: "all" },
        });
        assert.ok(adapter);
    });

    it("should accept deliverPolicy 'last' without construction error", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            consumerOptions: { deliverPolicy: "last" },
        });
        assert.ok(adapter);
    });

    it("should accept deliverPolicy 'new' without construction error", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            consumerOptions: { deliverPolicy: "new" },
        });
        assert.ok(adapter);
    });

    it("should default deliverPolicy when undefined (no consumerOptions)", () => {
        // When consumerOptions is omitted, toDeliverPolicy(undefined) returns
        // DeliverPolicy.New. This is tested indirectly: the adapter should not
        // throw during construction with no consumerOptions.
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
        });
        assert.ok(adapter);
    });

    // -----------------------------------------------------------------------
    // sanitizeDurableName() — private, replaces [^a-zA-Z0-9_-] with "_"
    //
    // This function is called inside subscribe() via consumerName().
    // We cannot directly test it without a live broker. Instead, we verify
    // that the adapter accepts stream names with special characters (dots,
    // wildcards) which would be passed through sanitizeDurableName().
    //
    // NOTE: sanitizeDurableName is exercised at subscribe time, not at
    // construction. The tests below verify construction accepts these values
    // without TypeError, but actual sanitization correctness requires an
    // integration test with a running NATS server.
    // -----------------------------------------------------------------------

    it("should accept stream name with dots (sanitized at subscribe time)", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            stream: "my.events.stream",
        });
        assert.ok(adapter);
    });

    it("should accept stream name with hyphens and underscores", () => {
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            stream: "my-events_stream",
        });
        assert.ok(adapter);
    });
});

describe("NatsAdapter AdapterContext", () => {
    // Note: connect() requires a running NATS server, so we test the interface
    // contract and error types rather than successful connection.

    it("connect() accepts AdapterContext parameter", () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });

        // connect() should accept an optional AdapterContext
        assert.equal(typeof adapter.connect, "function");
    });

    it("connect() accepts AdapterContext without TypeError", async () => {
        const adapter = NatsAdapter({ servers: "nats://invalid-host:4222" });

        // connect() will fail (no broker), but should accept the context
        // without throwing TypeError. The actual NATS connection name =
        // connectionOptions?.name ?? context?.serviceName
        await assert.rejects(
            () => adapter.connect({ serviceName: "order.v1@test-host" }),
            (err: Error) => {
                assert.ok(!(err instanceof TypeError), "Should not throw TypeError for AdapterContext");
                return true;
            },
        );
    });

    it("adapter can be constructed with explicit connectionOptions.name", () => {
        // Verify that providing both connectionOptions.name and context.serviceName
        // is valid. The priority chain is: connectionOptions.name > context.serviceName
        const adapter = NatsAdapter({
            servers: "nats://localhost:4222",
            connectionOptions: { name: "explicit-name" },
        });

        assert.equal(adapter.name, "nats");
    });

    it("connect() works with undefined context (backward compat)", async () => {
        const adapter = NatsAdapter({ servers: "nats://invalid-host:4222" });

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
