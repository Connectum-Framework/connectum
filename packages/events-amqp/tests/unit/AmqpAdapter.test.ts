import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { AmqpAdapter, classifyConfirmError, dispatchLifecycle, isConnectionLostError, toAmqpPattern, trackChannelClose, wireRecoveryLifecycle } from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishNackError, AmqpTopologyError } from "../../src/errors.ts";
import type { AmqpLifecycleCallbacks, AmqpLifecycleEvent } from "../../src/types.ts";

describe("isConnectionLostError", () => {
    it("classifies amqplib channel/connection-close errors as connection loss", () => {
        // amqplib rejects outstanding confirms with Error("channel closed") on drop
        assert.equal(isConnectionLostError(new Error("channel closed")), true);
        assert.equal(isConnectionLostError(new Error("Connection closed: 320")), true);
        assert.equal(isConnectionLostError(new Error("Socket closed unexpectedly")), true);
    });

    it("does NOT classify a genuine broker nack as connection loss", () => {
        // amqplib uses Error("message nacked") for a real negative ack
        assert.equal(isConnectionLostError(new Error("message nacked")), false);
    });

    it("returns false for non-Error values", () => {
        assert.equal(isConnectionLostError(undefined), false);
        assert.equal(isConnectionLostError("channel closed"), false);
        assert.equal(isConnectionLostError(null), false);
    });
});

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
            { message: "AmqpAdapter: not connected (or recovery in progress)" },
        );
    });

    it("should throw when subscribing without connection", async () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        await assert.rejects(
            () => adapter.subscribe(["test.>"], async () => {}),
            { message: "AmqpAdapter: not connected (or recovery in progress)" },
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

describe("AmqpAdapter connection guard", () => {
    it("should be safe to call disconnect() multiple times", async () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });
        // Multiple disconnect() calls should not throw
        await adapter.disconnect();
        await adapter.disconnect();
        await adapter.disconnect();
    });
});

describe("AmqpAdapter publisher options", () => {
    it("should construct with publisher options", () => {
        const adapter = AmqpAdapter({
            url: "amqp://localhost:5672",
            publisherOptions: {
                persistent: true,
                mandatory: false,
            },
        });
        assert.ok(adapter);
    });
});

describe("AmqpAdapter AdapterContext", () => {
    it("connect() accepts AdapterContext parameter", () => {
        const adapter = AmqpAdapter({ url: "amqp://localhost:5672" });

        // connect() should accept an optional AdapterContext
        assert.equal(typeof adapter.connect, "function");
    });

    it("connect() accepts AdapterContext without TypeError", async () => {
        // recovery: false — with recovery enabled (default), connect() retries
        // with backoff until the broker appears instead of rejecting.
        const adapter = AmqpAdapter({ url: "amqp://invalid-host:5672", recovery: false });

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
        // recovery: false — with recovery enabled (default), connect() retries
        // with backoff until the broker appears instead of rejecting.
        const adapter = AmqpAdapter({ url: "amqp://invalid-host:5672", recovery: false });

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

describe("classifyConfirmError", () => {
    const base = { closing: false, channelClosed: false, channelSwapped: false, routingKey: "rk" };

    it("classifies a genuine broker nack on a live channel as AmqpPublishNackError", () => {
        const out = classifyConfirmError({ ...base, err: new Error("message nacked") });
        assert.ok(out instanceof AmqpPublishNackError);
    });

    it("classifies via the structural close flag even when the error text does NOT match the regex", () => {
        // This is the discriminating case: a regex-only classifier would call
        // this a nack; the structural channelClosed flag correctly says connection loss.
        const out = classifyConfirmError({ ...base, channelClosed: true, err: new Error("some-future-amqplib-close-phrasing") });
        assert.ok(out instanceof AmqpConnectionError);
    });

    it("classifies via closing and channelSwapped structurally", () => {
        assert.ok(classifyConfirmError({ ...base, closing: true, err: new Error("message nacked") }) instanceof AmqpConnectionError);
        assert.ok(classifyConfirmError({ ...base, channelSwapped: true, err: new Error("message nacked") }) instanceof AmqpConnectionError);
    });

    it("still classifies the legacy text fallback as connection loss", () => {
        assert.ok(classifyConfirmError({ ...base, err: new Error("channel closed") }) instanceof AmqpConnectionError);
    });
});

describe("trackChannelClose", () => {
    it("sets the closed flag BEFORE amqplib's own close drain runs (prependListener)", () => {
        const ee = new EventEmitter();
        const closed = new WeakSet<EventEmitter>();

        // Simulate amqplib's constructor-registered close drain: registered FIRST,
        // it records what the flag looked like when it ran.
        let flagWhenDrainRan: boolean | undefined;
        ee.on("close", () => {
            flagWhenDrainRan = closed.has(ee);
        });

        // trackChannelClose registers AFTER the drain but must prepend, so its
        // flag-setter runs first.
        trackChannelClose(ee, closed);

        ee.emit("close");

        assert.equal(flagWhenDrainRan, true, "the close flag must be set before the drain listener runs (use prependListener, not on)");
        assert.equal(closed.has(ee), true);
    });
});

describe("wireRecoveryLifecycle", () => {
    function setup(lifecycle: AmqpLifecycleCallbacks) {
        const ee = new EventEmitter();
        let attempt = 0;
        let connectedDelivered = false;
        const calls = { clearPublishChannel: 0, failPendingReturns: 0, reset: 0 };
        wireRecoveryLifecycle(ee, lifecycle, {
            clearPublishChannel: () => {
                calls.clearPublishChannel += 1;
            },
            failPendingReturns: () => {
                calls.failPendingReturns += 1;
            },
            nextReconnectAttempt: () => {
                attempt += 1;
                return attempt;
            },
            resetReconnectAttempt: () => {
                calls.reset += 1;
                attempt = 0;
            },
            // Mirrors the adapter's ordering-independent exactly-once scheme:
            // the first delivery is the initial connect, later ones reconnects.
            deliverConnected: () => {
                const reconnected = connectedDelivered;
                connectedDelivered = true;
                dispatchLifecycle(lifecycle, { type: "connected", reconnected });
            },
        });
        return { ee, calls };
    }

    it("fires onReconnecting exactly once per failed attempt (connect-failed + reconnect-scheduled pair)", () => {
        const reconnecting: Array<{ attempt: number; delay: number }> = [];
        const { ee } = setup({ onReconnecting: (info) => reconnecting.push({ attempt: info.attempt, delay: info.delay }) });

        // amqplib emits BOTH connect-failed and reconnect-scheduled for one failed attempt.
        ee.emit("connect-failed", new Error("attempt failed"));
        ee.emit("reconnect-scheduled", { attempt: 1, delay: 100, error: new Error("attempt failed") });

        assert.equal(reconnecting.length, 1, "onReconnecting must fire once per scheduled retry, not also on connect-failed");
        assert.deepEqual(reconnecting[0], { attempt: 1, delay: 100 });
    });

    it("reports the terminal exhausted case via onReconnectFailed, not onReconnecting", () => {
        let reconnecting = 0;
        let reconnectFailed = 0;
        const { ee, calls } = setup({
            onReconnecting: () => {
                reconnecting += 1;
            },
            onReconnectFailed: () => {
                reconnectFailed += 1;
            },
        });

        ee.emit("connect-failed", new Error("attempt failed"));
        ee.emit("reconnect-failed", new Error("recovery exhausted"));

        assert.equal(reconnecting, 0);
        assert.equal(reconnectFailed, 1);
        assert.equal(calls.clearPublishChannel, 2, "both connect-failed and reconnect-failed clear the publish channel");
    });

    it("reports a topology setup failure on a reconnect via onSetupFailed with attempt context", () => {
        const setupFailures: Array<{ initial: boolean; attempt: number }> = [];
        const { ee } = setup({ onSetupFailed: (_err, ctx) => setupFailures.push({ ...ctx }) });

        ee.emit("connect-failed", new AmqpTopologyError("Topology declaration failed: 406"));
        ee.emit("connect-failed", new AmqpTopologyError("Topology declaration failed: 406"));

        assert.deepEqual(setupFailures, [
            { initial: false, attempt: 1 },
            { initial: false, attempt: 2 },
        ]);
    });

    it("does NOT call onSetupFailed for a non-topology connect-failed", () => {
        let setupFailed = 0;
        const { ee } = setup({ onSetupFailed: () => {
            setupFailed += 1;
        } });

        ee.emit("connect-failed", new Error("ECONNRESET"));
        assert.equal(setupFailed, 0);
    });

    it("resets the attempt counter and fires onConnected on connect; drains pending on disconnect", () => {
        let connected = 0;
        const disconnects: Error[] = [];
        const { ee, calls } = setup({
            onConnected: () => {
                connected += 1;
            },
            onDisconnected: (cause) => disconnects.push(cause),
        });

        ee.emit("connect-failed", new Error("x")); // attempt -> 1
        ee.emit("connect"); // resets attempt
        ee.emit("disconnect", new Error("dropped"));

        assert.equal(connected, 1);
        assert.equal(calls.reset, 1);
        assert.equal(calls.failPendingReturns, 1);
        assert.deepEqual(disconnects.map((e) => e.message), ["dropped"]);
    });

    it("delivers the full discriminated union to onLifecycle (first connected is initial, later ones reconnected)", () => {
        const events: AmqpLifecycleEvent[] = [];
        const { ee } = setup({ onLifecycle: (event) => events.push(event) });

        const topoErr = new AmqpTopologyError("Topology declaration failed: 406");
        const dropErr = new Error("dropped");
        const exhaustedErr = new Error("recovery exhausted");

        ee.emit("connect-failed", topoErr); // attempt -> 1
        ee.emit("reconnect-scheduled", { attempt: 1, delay: 100, error: topoErr });
        ee.emit("connect"); // first delivery in this harness → initial
        ee.emit("blocked", "memory alarm");
        ee.emit("unblocked");
        ee.emit("disconnect", dropErr);
        ee.emit("connect"); // second delivery → a recovery re-connect
        ee.emit("reconnect-failed", exhaustedErr);

        assert.deepEqual(events, [
            { type: "setup-failed", initial: false, attempt: 1, error: topoErr },
            { type: "reconnecting", attempt: 1, delay: 100, error: topoErr },
            { type: "connected", reconnected: false },
            { type: "blocked", reason: "memory alarm" },
            { type: "unblocked" },
            { type: "disconnected", error: dropErr },
            { type: "connected", reconnected: true },
            { type: "reconnect-failed", error: exhaustedErr },
        ]);
    });
});

describe("dispatchLifecycle", () => {
    it("invokes onLifecycle first, then the matching flat shim", () => {
        const order: string[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => order.push(`union:${event.type}`),
            onConnected: () => order.push("flat:connected"),
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
        assert.deepEqual(order, ["union:connected", "flat:connected"]);
    });

    it("maps every event type to its flat callback with the legacy payload shape", () => {
        const flat: Array<[string, unknown]> = [];
        const err = new Error("boom");
        const lifecycle: AmqpLifecycleCallbacks = {
            onConnected: () => flat.push(["connected", undefined]),
            onDisconnected: (cause) => flat.push(["disconnected", cause]),
            onReconnecting: (info) => flat.push(["reconnecting", info]),
            onReconnectFailed: (cause) => flat.push(["reconnect-failed", cause]),
            onSetupFailed: (error, ctx) => flat.push(["setup-failed", { error, ctx }]),
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: true });
        dispatchLifecycle(lifecycle, { type: "disconnected", error: err });
        dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: 3, delay: 250, error: err });
        dispatchLifecycle(lifecycle, { type: "reconnect-failed", error: err });
        dispatchLifecycle(lifecycle, { type: "setup-failed", initial: true, attempt: 0, error: err });

        assert.deepEqual(flat, [
            ["connected", undefined],
            ["disconnected", err],
            ["reconnecting", { attempt: 3, delay: 250, error: err }],
            ["reconnect-failed", err],
            ["setup-failed", { error: err, ctx: { initial: true, attempt: 0 } }],
        ]);
    });

    it("blocked/unblocked are union-only: no flat callback fires", () => {
        const union: string[] = [];
        let flatCalls = 0;
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => union.push(event.type),
            onConnected: () => {
                flatCalls += 1;
            },
            onDisconnected: () => {
                flatCalls += 1;
            },
        };

        dispatchLifecycle(lifecycle, { type: "blocked", reason: "disk alarm" });
        dispatchLifecycle(lifecycle, { type: "unblocked" });

        assert.deepEqual(union, ["blocked", "unblocked"]);
        assert.equal(flatCalls, 0);
    });

    it("is a no-op without a lifecycle object", () => {
        assert.doesNotThrow(() => dispatchLifecycle(undefined, { type: "unblocked" }));
    });

    it("isolates a throwing onLifecycle: no propagation, flat shim still fires", () => {
        let flatFired = 0;
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: () => {
                throw new Error("user metrics bug");
            },
            onConnected: () => {
                flatFired += 1;
            },
        };

        assert.doesNotThrow(() => dispatchLifecycle(lifecycle, { type: "connected", reconnected: true }));
        assert.equal(flatFired, 1, "a throwing onLifecycle must not starve the flat shim");
    });

    it("isolates a throwing flat callback: no propagation, onLifecycle already delivered", () => {
        const union: string[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => union.push(event.type),
            onDisconnected: () => {
                throw new Error("user handler bug");
            },
        };

        assert.doesNotThrow(() => dispatchLifecycle(lifecycle, { type: "disconnected", error: new Error("drop") }));
        assert.deepEqual(union, ["disconnected"]);
    });
});
