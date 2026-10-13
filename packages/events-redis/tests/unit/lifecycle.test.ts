import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { dispatchLifecycle, type WatchableRedisClient, watchConnection } from "../../src/lifecycle.ts";
import type { RedisLifecycleEvent } from "../../src/types.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("dispatchLifecycle", () => {
    it("does nothing without a callback", () => {
        assert.doesNotThrow(() => dispatchLifecycle(undefined, { type: "connected", reconnected: false, connection: "publisher" }));
    });

    it("isolates a synchronous throw and reports it once as lifecycle-error", () => {
        const seen: RedisLifecycleEvent[] = [];
        dispatchLifecycle(
            {
                onLifecycle: (e) => {
                    seen.push(e);
                    if (e.type !== "lifecycle-error") {
                        throw new Error("boom");
                    }
                },
            },
            { type: "connected", reconnected: false, connection: "publisher" },
        );
        assert.deepEqual(
            seen.map((e) => e.type),
            ["connected", "lifecycle-error"],
        );
    });

    it("isolates a rejected promise and drops a failure while handling lifecycle-error", async () => {
        let calls = 0;
        dispatchLifecycle(
            {
                onLifecycle: async () => {
                    calls += 1;
                    throw new Error("always");
                },
            },
            { type: "connected", reconnected: false, connection: "publisher" },
        );
        await tick();
        await tick();
        assert.equal(calls, 2, "the event and one lifecycle-error, no more");
    });
});

describe("watchConnection state machine", () => {
    function watched(own = { value: false }) {
        const client = new EventEmitter();
        const events: RedisLifecycleEvent[] = [];
        watchConnection(client as unknown as WatchableRedisClient, "publisher", { onLifecycle: (e) => void events.push(e) }, () => own.value);
        return { client, events, own };
    }

    it("first ready is connected false, a later ready is connected true", () => {
        const { client, events } = watched();
        client.emit("ready");
        client.emit("close");
        client.emit("ready");
        assert.deepEqual(
            events.map((e) => (e.type === "connected" ? `connected:${e.reconnected}` : e.type)),
            ["connected:false", "disconnected", "connected:true"],
        );
    });

    it("reports one disconnected per loss although the client emits close for every failed attempt", () => {
        const { client, events } = watched();
        client.emit("ready");
        client.emit("close");
        client.emit("reconnecting", 50);
        client.emit("close");
        client.emit("reconnecting", 100);
        client.emit("close");
        assert.equal(events.filter((e) => e.type === "disconnected").length, 1);
        assert.deepEqual(
            events.filter((e) => e.type === "reconnecting").map((e) => (e as Extract<RedisLifecycleEvent, { type: "reconnecting" }>).attempt),
            [1, 2],
        );
    });

    it("resets the attempt count on ready and carries the last error as the cause", () => {
        const { client, events } = watched();
        client.emit("ready");
        client.emit("error", new Error("ECONNRESET"));
        client.emit("close");
        client.emit("reconnecting", 50);
        client.emit("ready");
        client.emit("close");
        client.emit("reconnecting", 50);
        const disconnected = events.filter((e) => e.type === "disconnected") as Extract<RedisLifecycleEvent, { type: "disconnected" }>[];
        assert.equal(disconnected[0]?.error.message, "ECONNRESET");
        const attempts = events.filter((e) => e.type === "reconnecting").map((e) => (e as Extract<RedisLifecycleEvent, { type: "reconnecting" }>).attempt);
        assert.deepEqual(attempts, [1, 1]);
    });

    it("stays silent before the first ready: connect() reports that failure itself", () => {
        const { client, events } = watched();
        client.emit("error", new Error("ECONNREFUSED"));
        client.emit("close");
        client.emit("reconnecting", 50);
        client.emit("end");
        assert.deepEqual(events, []);
    });

    it("stays silent for a close the adapter started", () => {
        const { client, events, own } = watched();
        client.emit("ready");
        own.value = true;
        client.emit("close");
        client.emit("end");
        assert.deepEqual(
            events.map((e) => e.type),
            ["connected"],
        );
    });

    it("reports the end of a client the adapter did not close as reconnect-failed", () => {
        const { client, events } = watched();
        client.emit("ready");
        client.emit("close");
        client.emit("end");
        assert.deepEqual(
            events.map((e) => e.type),
            ["connected", "disconnected", "reconnect-failed"],
        );
    });
});
