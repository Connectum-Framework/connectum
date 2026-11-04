/**
 * `disconnect()` must end a `connect()` that is still waiting for the broker,
 * also when the initial connect has no retry budget (the default). Against a
 * closed port the default recovery retries without limit, so before the fix the
 * pending `connect()` outlived `disconnect()` and kept the process alive.
 *
 * These tests use the real `amqplib` and a closed local port; no broker runs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmqpAdapter, AmqpConnectionError } from "../../src/index.ts";

/** Port 1 is reserved and nothing listens there, so every attempt is refused at once. */
const CLOSED_PORT_URL = "amqp://127.0.0.1:1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { readonly settled: "resolved" } | { readonly settled: "rejected"; readonly error: unknown } | { readonly settled: "pending" };

/** Observe a promise for at most `ms`, so a hang is a failed assertion and not a test timeout. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<Outcome> {
    const timeout = sleep(ms).then((): Outcome => ({ settled: "pending" }));
    const outcome = promise.then(
        (): Outcome => ({ settled: "resolved" }),
        (error: unknown): Outcome => ({ settled: "rejected", error }),
    );
    return Promise.race([outcome, timeout]);
}

describe("disconnect() cancels a pending connect()", () => {
    it("default recovery (no initialConnectMaxRetries): connect() rejects with AmqpConnectionError and no retry keeps running", { timeout: 20_000 }, async () => {
        const events: string[] = [];
        const adapter = AmqpAdapter({
            url: CLOSED_PORT_URL,
            recovery: { initialDelay: 10, maxDelay: 20 },
            lifecycle: { onLifecycle: (event) => events.push(event.type) },
        });
        const connect = adapter.connect();
        connect.catch(() => undefined);

        // Several refused attempts have happened by now: the connect is waiting in its retry loop.
        await sleep(300);
        assert.deepEqual(await settleWithin(connect, 10), { settled: "pending" }, "connect() must still be waiting before disconnect()");

        await adapter.disconnect();
        const outcome = await settleWithin(connect, 2_000);
        assert.equal(outcome.settled, "rejected", "the cancelled connect() must settle");
        const error = (outcome as { error: unknown }).error;
        assert.ok(error instanceof AmqpConnectionError, `expected AmqpConnectionError, got ${String(error)}`);
        assert.match(error.message, /Adapter closed during the initial connect phase/);

        // The retry loop is gone: nothing is reported after the rejection.
        const seen = events.length;
        await sleep(150);
        assert.equal(events.length, seen, "no lifecycle event may follow the cancelled connect()");
    });

    it("default recovery: the initial window stays unreported while connect() waits", { timeout: 20_000 }, async () => {
        const events: string[] = [];
        const adapter = AmqpAdapter({
            url: CLOSED_PORT_URL,
            recovery: { initialDelay: 10, maxDelay: 20 },
            lifecycle: { onLifecycle: (event) => events.push(event.type) },
        });
        const connect = adapter.connect();
        connect.catch(() => undefined);
        await sleep(300);
        await adapter.disconnect();
        await settleWithin(connect, 2_000);
        // The lifecycle callback presence runs the startup probe, which reports nothing for an unreachable broker.
        assert.deepEqual(
            events.filter((type) => type === "reconnecting"),
            [],
            "without initialConnectMaxRetries the per-attempt events of the initial window are not reported",
        );
    });

    it("a connect() made after the cancelled one starts a fresh attempt", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url: CLOSED_PORT_URL, recovery: { initialDelay: 10, maxDelay: 20 } });
        const first = adapter.connect();
        first.catch(() => undefined);
        await sleep(100);
        await adapter.disconnect();
        assert.equal((await settleWithin(first, 2_000)).settled, "rejected");

        const second = adapter.connect();
        second.catch(() => undefined);
        await sleep(100);
        assert.deepEqual(await settleWithin(second, 10), { settled: "pending" }, "the second connect() is a live attempt, not 'already in progress'");
        await adapter.disconnect();
        assert.equal((await settleWithin(second, 2_000)).settled, "rejected");
    });

    it("finite maxRetries without a startup budget: the exhausted loop still rejects with the typed give-up error", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url: CLOSED_PORT_URL, recovery: { maxRetries: 2, initialDelay: 5, maxDelay: 10 } });
        const outcome = await settleWithin(adapter.connect(), 5_000);
        assert.equal(outcome.settled, "rejected");
        const error = (outcome as { error: unknown }).error;
        assert.ok(error instanceof AmqpConnectionError);
        assert.match(error.message, /Initial connect failed: recovery gave up \(maxRetries: 2\)/);
        assert.ok(error.cause instanceof Error, "the last connection error is kept as the cause");
    });
});
