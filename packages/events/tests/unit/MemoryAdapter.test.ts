import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryAdapter } from "../../src/MemoryAdapter.ts";
import type { RawEvent } from "../../src/types.ts";

describe("MemoryAdapter", () => {
    it("connects and disconnects", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();
        await adapter.disconnect();
    });

    it("publishes and receives events", async () => {
        const adapter = MemoryAdapter();
        await adapter.connect();

        const received: RawEvent[] = [];
        await adapter.subscribe(["test.topic"], async (event) => {
            received.push(event);
        });

        const before = Date.now();
        await adapter.publish("test.topic", new Uint8Array([1, 2, 3]), { metadata: { "x-trace": "abc" } });
        await adapter.publish("test.topic", new Uint8Array([4]));
        const after = Date.now();

        assert.equal(received.length, 2);
        const [first, second] = received as [RawEvent, RawEvent];
        assert.equal(first.eventType, "test.topic");
        assert.deepEqual([...first.payload], [1, 2, 3], "the published bytes are delivered unchanged");
        assert.equal(first.attempt, 1, "first delivery is attempt 1 (attempts are 1-based)");
        assert.ok(first.publishedAt.getTime() >= before && first.publishedAt.getTime() <= after, "publishedAt is the publish time");
        assert.equal(first.metadata.get("x-trace"), "abc", "publish metadata is delivered as event headers");
        assert.equal(first.metadata.size, 1);
        assert.ok(first.eventId.length > 0, "every event has an identifier");
        assert.notEqual(first.eventId, second.eventId, "event identifiers are unique per event");
        assert.deepEqual([...second.payload], [4]);
        assert.equal(second.metadata.size, 0, "metadata of one event does not leak into the next");

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
