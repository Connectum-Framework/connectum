import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";

describe("MemoryAdapter", () => {
    it("connects and disconnects", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        await adapter.disconnect();
    });

    it("publishes and receives events", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();

        const received: string[] = [];
        await adapter.subscribe(["test.topic"], async (event) => {
            received.push(event.eventType);
        });

        await adapter.publish("test.topic", new Uint8Array([1, 2, 3]));
        assert.deepEqual(received, ["test.topic"]);

        await adapter.disconnect();
    });

    it("wildcard * matches single segment", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();

        const received: string[] = [];
        await adapter.subscribe(["user.*"], async (event) => {
            received.push(event.eventType);
        });

        await adapter.publish("user.created", new Uint8Array());
        await adapter.publish("user.updated", new Uint8Array());
        await adapter.publish("order.created", new Uint8Array());

        assert.deepEqual(received, ["user.created", "user.updated"]);
        await adapter.disconnect();
    });

    it("wildcard > matches multiple segments", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();

        const received: string[] = [];
        await adapter.subscribe(["user.>"], async (event) => {
            received.push(event.eventType);
        });

        await adapter.publish("user.created", new Uint8Array());
        await adapter.publish("user.created.v2", new Uint8Array());
        await adapter.publish("order.created", new Uint8Array());

        assert.deepEqual(received, ["user.created", "user.created.v2"]);
        await adapter.disconnect();
    });

    it("throws when publishing without connection", async () => {
        const adapter = MemoryAdapter();
        await assert.rejects(
            () => adapter.publish("test", new Uint8Array()),
            { message: "MemoryAdapter: not connected" },
        );
    });

    it("unsubscribe removes handler", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();

        const received: string[] = [];
        const sub = await adapter.subscribe(["test"], async (event) => {
            received.push(event.eventType);
        });

        await adapter.publish("test", new Uint8Array());
        assert.equal(received.length, 1);

        await sub.unsubscribe();
        await adapter.publish("test", new Uint8Array());
        assert.equal(received.length, 1);

        await adapter.disconnect();
    });
});
