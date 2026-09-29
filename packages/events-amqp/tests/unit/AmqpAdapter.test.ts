import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
    AmqpAdapter,
    buildRecoveryConnectOptions,
    classifyConfirmError,
    computeRecoveryDelay,
    createBackoffGuard,
    dispatchLifecycle,
    isAutoRetriablePublishError,
    isConnectionLostError,
    isDeterministicTopologyDrift,
    normalizeInitialConnectBudget,
    toAmqpPattern,
    trackChannelClose,
    wireRecoveryLifecycle,
} from "../../src/AmqpAdapter.ts";
import { AmqpConnectionError, AmqpPublishNackError, AmqpPublishTimeoutError, AmqpSerializationError, AmqpTopologyError, AmqpUnroutableError } from "../../src/errors.ts";
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

    // With a finite maxRetries and no initialConnectMaxRetries, amqplib's own
    // initial loop gives up and rejects connect() with its raw last error
    // (ECONNREFUSED, ...). The public boundary must keep the typed taxonomy,
    // with the original error preserved as the cause. Port 1 on loopback has
    // no listener, so every attempt is refused at once — no broker needed.
    it("rejects connect() with a typed AmqpConnectionError when recovery gives up on the initial connect", async () => {
        const adapter = AmqpAdapter({
            url: "amqp://127.0.0.1:1",
            recovery: { maxRetries: 1, initialDelay: 10, maxDelay: 20 },
        });
        try {
            await assert.rejects(
                () => adapter.connect(),
                (err: unknown) => {
                    assert.ok(err instanceof AmqpConnectionError, `expected AmqpConnectionError, got: ${String(err)}`);
                    assert.ok(err.cause instanceof Error, "the original connection error is kept as the cause");
                    return true;
                },
            );
        } finally {
            await adapter.disconnect();
        }
    });
});

describe("initialConnectMaxRetries normalization", () => {
    it("a finite value becomes max(0, floor(n)); anything that is not a finite number is unset", () => {
        assert.equal(normalizeInitialConnectBudget(-3), 0);
        assert.equal(normalizeInitialConnectBudget(0), 0);
        assert.equal(normalizeInitialConnectBudget(2), 2);
        assert.equal(normalizeInitialConnectBudget(2.7), 2);
        assert.equal(normalizeInitialConnectBudget(Number.POSITIVE_INFINITY), null);
        assert.equal(normalizeInitialConnectBudget(Number.NaN), null);
        assert.equal(normalizeInitialConnectBudget("2"), null);
        assert.equal(normalizeInitialConnectBudget(undefined), null);
    });

    it("forwards the budget to amqplib as initialMaxRetries with waitForConnect: false, and neither key when unset", () => {
        const setup = async (): Promise<void> => undefined;
        const recovery = { initialDelay: 10, maxDelay: 20, factor: 3, jitter: 0.1, maxRetries: 7 };

        assert.deepEqual(buildRecoveryConnectOptions({ recovery, setup, initialBudget: 2 }), {
            initialDelay: 10,
            maxDelay: 20,
            factor: 3,
            jitter: 0.1,
            maxRetries: 7,
            setup,
            initialMaxRetries: 2,
            waitForConnect: false,
        });

        const unset = buildRecoveryConnectOptions({ recovery, setup, initialBudget: null });
        assert.equal(Object.hasOwn(unset, "initialMaxRetries"), false);
        assert.equal(Object.hasOwn(unset, "waitForConnect"), false, "amqplib keeps resolving connect() only after the first success");
    });

    /**
     * The normalization table observed end to end. Port 1 on loopback has no
     * listener, so every attempt is refused at once — no broker needed.
     * Attempts = scheduled retries + 1.
     */
    async function attemptsFor(initialConnectMaxRetries: number): Promise<{ attempts: number; error: unknown }> {
        const retries: number[] = [];
        const adapter = AmqpAdapter({
            url: "amqp://127.0.0.1:1",
            recovery: { initialDelay: 1, maxDelay: 2, jitter: 0, maxRetries: 1, initialConnectMaxRetries },
            lifecycle: {
                onLifecycle: (event) => {
                    if (event.type === "reconnecting") {
                        retries.push(event.attempt);
                    }
                },
            },
        });
        try {
            await adapter.connect();
            return { attempts: retries.length + 1, error: null };
        } catch (error) {
            return { attempts: retries.length + 1, error };
        } finally {
            await adapter.disconnect();
        }
    }

    it("-3, 0, 2 and 2.7 give 1, 1, 3 and 3 attempts before connect() rejects", async () => {
        for (const [value, expected] of [
            [-3, 1],
            [0, 1],
            [2, 3],
            [2.7, 3],
        ] as const) {
            const { attempts, error } = await attemptsFor(value);
            assert.equal(attempts, expected, `initialConnectMaxRetries: ${value}`);
            assert.ok(error instanceof AmqpConnectionError, `initialConnectMaxRetries: ${value} rejects typed`);
            assert.equal(error.message, `Initial connect failed after ${expected} attempt(s) (initialConnectMaxRetries: ${expected - 1})`);
        }
    });

    it("Infinity and NaN behave exactly as the option unset: maxRetries bounds the initial connect and no retry is reported", async () => {
        for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
            const { attempts, error } = await attemptsFor(value);
            assert.ok(error instanceof AmqpConnectionError, `initialConnectMaxRetries: ${value} rejects typed`);
            assert.equal(error.message, "Initial connect failed: recovery gave up (maxRetries: 1)", `initialConnectMaxRetries: ${value} takes the unset path`);
            assert.equal(attempts, 1, `initialConnectMaxRetries: ${value} reports no initial-window retry, as unset`);
        }
    });
});

describe("recovery.backoff option combinations", () => {
    const backoff = (attempt: number): number => 100 * attempt;

    for (const knob of ["initialDelay", "maxDelay", "factor", "jitter"] as const) {
        it(`rejects backoff combined with ${knob} at construction, naming both options`, () => {
            // amqplib ignores the numeric delay knobs once a custom delay
            // function is set, so accepting the pair would be a silent no-op.
            assert.throws(
                () => AmqpAdapter({ url: "amqp://localhost:5672", recovery: { backoff, [knob]: 1 } }),
                (err: unknown) => {
                    assert.ok(err instanceof TypeError, `expected TypeError, got: ${String(err)}`);
                    assert.match(err.message, /recovery\.backoff/);
                    assert.match(err.message, new RegExp(`recovery\\.${knob}\\b`));
                    return true;
                },
            );
        });
    }

    it("accepts backoff together with maxRetries and initialConnectMaxRetries — the budgets still apply", () => {
        assert.doesNotThrow(() => AmqpAdapter({ url: "amqp://localhost:5672", recovery: { backoff, maxRetries: 5, initialConnectMaxRetries: 3 } }));
    });

    it("accepts the delay knobs without backoff", () => {
        assert.doesNotThrow(() => AmqpAdapter({ url: "amqp://localhost:5672", recovery: { initialDelay: 1, maxDelay: 2, factor: 3, jitter: 0.5 } }));
    });
});

describe("createBackoffGuard", () => {
    it("passes a valid return through unchanged — 0 means an immediate retry, rounding is amqplib's", () => {
        const values = [0, 1500.4];
        const guard = createBackoffGuard(() => values.shift() as number);
        assert.equal(guard.calculateDelay(1), 0);
        assert.equal(guard.calculateDelay(2), 1500.4);
        assert.equal(guard.giveUpError(), null);
    });

    it("a throwing hook: rethrows the same error so amqplib gives up, and records it as the cause of a typed give-up", () => {
        const boom = new Error("boom");
        const guard = createBackoffGuard(() => {
            throw boom;
        });
        guard.noteConnectionError(new Error("ECONNREFUSED 127.0.0.1:5672"));
        assert.throws(
            () => guard.calculateDelay(3),
            (err: unknown) => err === boom,
        );
        const giveUp = guard.giveUpError();
        assert.ok(giveUp instanceof AmqpConnectionError);
        assert.equal(giveUp.cause, boom);
        assert.match(giveUp.message, /recovery\.backoff/);
        assert.match(giveUp.message, /attempt 3/);
        assert.match(giveUp.message, /ECONNREFUSED 127\.0\.0\.1:5672/, "the message names the last connection error");
        assert.equal(guard.giveUpError(), giveUp, "the same error object on every read, so connect() and the terminal event agree");
    });

    it("a throwing hook with a non-Error value: the cause is an Error carrying the thrown value", () => {
        const guard = createBackoffGuard(() => {
            throw "nope";
        });
        assert.throws(() => guard.calculateDelay(1));
        const cause = guard.giveUpError()?.cause;
        assert.ok(cause instanceof Error);
        assert.match(cause.message, /nope/);
    });

    for (const [label, value] of [
        ["-1", -1],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["NaN", Number.NaN],
        ["the numeric string '1000'", "1000"],
        ["undefined", undefined],
    ] as const) {
        it(`an invalid return (${label}) gives up with a typed error whose cause states the invalid return`, () => {
            const guard = createBackoffGuard(() => value as unknown as number);
            assert.throws(() => guard.calculateDelay(2));
            const giveUp = guard.giveUpError();
            assert.ok(giveUp instanceof AmqpConnectionError);
            assert.ok(giveUp.cause instanceof Error);
            assert.match(giveUp.cause.message, /finite, non-negative number/);
            assert.match(giveUp.cause.message, new RegExp(String(value)));
        });
    }

    it("a Promise return gives up with 'must be synchronous' and is not awaited", () => {
        let rejectLater: ((err: Error) => void) | undefined;
        const pending = new Promise<number>((_resolve, reject) => {
            rejectLater = reject;
        });
        const guard = createBackoffGuard(() => pending as unknown as number);
        assert.throws(() => guard.calculateDelay(1));
        const giveUp = guard.giveUpError();
        assert.ok(giveUp instanceof AmqpConnectionError);
        assert.ok(giveUp.cause instanceof Error);
        assert.match(giveUp.cause.message, /must be synchronous/);
        // The guard attached a rejection handler: a later rejection is not unhandled.
        rejectLater?.(new Error("late"));
    });

    it("without a noted connection error the message says none was observed", () => {
        const guard = createBackoffGuard(() => -1);
        assert.throws(() => guard.calculateDelay(1));
        assert.match(guard.giveUpError()?.message ?? "", /last connection error: none observed/);
    });

    it("the documented full-jitter example stays within [0, min(30000, 100 × 2^(n−1))) and is accepted by the guard", () => {
        // Kept character for character equal to the example in the package
        // README and in the AmqpRecoveryOptions.backoff JSDoc.
        const example = (n: number): number => Math.random() * Math.min(30_000, 100 * 2 ** (n - 1));
        assert.doesNotThrow(() => AmqpAdapter({ url: "amqp://localhost:5672", recovery: { backoff: example } }));
        const guard = createBackoffGuard(example);
        for (let n = 1; n <= 20; n += 1) {
            const cap = Math.min(30_000, 100 * 2 ** (n - 1));
            for (let draw = 0; draw < 200; draw += 1) {
                const delay = guard.calculateDelay(n);
                assert.ok(delay >= 0 && delay < cap, `attempt ${n}: ${delay} outside [0, ${cap})`);
            }
        }
        assert.equal(guard.giveUpError(), null);
    });

    it("is forwarded to amqplib as calculateDelay only when backoff is set", () => {
        const setup = async (): Promise<void> => undefined;
        const guard = createBackoffGuard(() => 1);
        assert.equal(buildRecoveryConnectOptions({ recovery: {}, setup, initialBudget: null, calculateDelay: guard.calculateDelay }).calculateDelay, guard.calculateDelay);
        assert.equal(Object.hasOwn(buildRecoveryConnectOptions({ recovery: {}, setup, initialBudget: null }), "calculateDelay"), false);
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
    function setup(
        lifecycle: AmqpLifecycleCallbacks,
        opts?: {
            fatalGate?: (err: Error) => boolean;
            isClosing?: () => boolean;
            isInitialWindow?: () => boolean;
            initialFailFastGate?: (err: Error) => boolean;
            mapGiveUpError?: (err: Error) => Error;
        },
    ) {
        const ee = new EventEmitter();
        let attempt = 0;
        let initialAttempts = 0;
        let connectedDelivered = false;
        const calls = {
            clearPublishChannel: 0,
            failPendingReturns: 0,
            reset: 0,
            enterFatalState: 0,
            markCycleDead: 0,
            stopInitialConnect: [] as Error[],
            noteConnectionError: [] as Error[],
        };
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
            fatalTopologyGate: opts?.fatalGate ?? (() => false),
            enterFatalState: () => {
                calls.enterFatalState += 1;
            },
            markCycleDead: () => {
                calls.markCycleDead += 1;
            },
            isClosing: opts?.isClosing ?? (() => false),
            isInitialWindow: opts?.isInitialWindow ?? (() => false),
            nextInitialAttempt: () => {
                initialAttempts += 1;
                return initialAttempts - 1;
            },
            initialFailFastGate: opts?.initialFailFastGate ?? (() => false),
            stopInitialConnect: (err) => {
                calls.stopInitialConnect.push(err);
            },
            noteConnectionError: (err) => {
                calls.noteConnectionError.push(err);
            },
            mapGiveUpError: opts?.mapGiveUpError ?? ((err) => err),
        });
        return { ee, calls };
    }

    it("reports a give-up with the adapter's mapped error and remembers every connection error on the way", () => {
        const events: AmqpLifecycleEvent[] = [];
        const hookErr = new Error("recovery.backoff must return a finite, non-negative number");
        const typed = new AmqpConnectionError("Recovery gave up", { cause: hookErr });
        const { ee, calls } = setup({ onLifecycle: (event) => events.push(event) }, { mapGiveUpError: (err) => (err === hookErr ? typed : err) });

        const dropErr = new Error("dropped");
        const refusedErr = new Error("ECONNREFUSED");
        ee.emit("disconnect", dropErr);
        ee.emit("connect-failed", refusedErr);
        ee.emit("reconnect-failed", hookErr);

        assert.deepEqual(calls.noteConnectionError, [dropErr, refusedErr]);
        assert.deepEqual(events.at(-1), { type: "reconnect-failed", error: typed });
        assert.equal(calls.markCycleDead, 1);
    });

    it("initial window: a setup failure reports setup-failed{initial:true} with the 0-based attempt index, and the retry reports reconnecting", () => {
        const events: AmqpLifecycleEvent[] = [];
        const { ee, calls } = setup({ onLifecycle: (event) => events.push(event) }, { isInitialWindow: () => true });
        const topoErr = new AmqpTopologyError("Topology check failed: NOT_FOUND");

        ee.emit("connect-failed", topoErr);
        ee.emit("reconnect-scheduled", { attempt: 1, delay: 50, error: topoErr });
        ee.emit("connect-failed", new Error("ECONNREFUSED"));
        ee.emit("connect-failed", topoErr);

        assert.deepEqual(events, [
            { type: "setup-failed", initial: true, attempt: 0, error: topoErr },
            { type: "reconnecting", attempt: 1, delay: 50, error: topoErr },
            { type: "setup-failed", initial: true, attempt: 2, error: topoErr },
        ]);
        assert.equal(calls.clearPublishChannel, 3, "a failed attempt leaves no half-open publish channel behind");
    });

    it("initial window: the steady-state fatal topology gate does not act, the startup fail-fast gate does", () => {
        const events: string[] = [];
        const codeErr = Object.assign(new Error("NOT_FOUND - no queue 'q'"), { code: 404 });
        const topoErr = new AmqpTopologyError("Topology check failed: NOT_FOUND", { cause: codeErr });

        const noFailFast = setup({ onLifecycle: (event) => events.push(event.type) }, { isInitialWindow: () => true, fatalGate: () => true });
        noFailFast.ee.emit("connect-failed", topoErr);
        assert.equal(noFailFast.calls.enterFatalState, 0, "treatTopologyErrorAsFatal governs steady-state recovery only");
        assert.deepEqual(noFailFast.calls.stopInitialConnect, []);
        assert.deepEqual(events, ["setup-failed"], "no terminal event from the steady-state gate");

        const failFast = setup({}, { isInitialWindow: () => true, initialFailFastGate: (err) => err instanceof AmqpTopologyError });
        failFast.ee.emit("connect-failed", topoErr);
        assert.deepEqual(failFast.calls.stopInitialConnect, [topoErr], "the startup fail-fast stops the initial connect with the setup error");
        assert.equal(failFast.calls.enterFatalState, 0);
    });

    it("initial window: after disconnect() started, a late failure and its retry are not reported and touch no adapter state", () => {
        const events: string[] = [];
        const topoErr = new AmqpTopologyError("Topology declaration failed: channel closed");
        const { ee, calls } = setup(
            { onLifecycle: (event) => events.push(event.type) },
            { isInitialWindow: () => true, isClosing: () => true, initialFailFastGate: () => true },
        );

        ee.emit("connect-failed", topoErr);
        ee.emit("reconnect-scheduled", { attempt: 1, delay: 50, error: topoErr });

        assert.deepEqual(events, []);
        assert.equal(calls.clearPublishChannel, 0, "a newer connection's publish channel must not be cleared by a stale failure");
        assert.deepEqual(calls.stopInitialConnect, []);
    });

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
        assert.equal(calls.clearPublishChannel, 1, "a failed attempt only clears the half-open publish channel");
        assert.equal(calls.markCycleDead, 1, "the give-up forgets the whole dead cycle exactly once");
    });

    it("forgets the dead cycle BEFORE the give-up reaches user callbacks, and never on a retriable failure", () => {
        // A callback that reconnects on give-up must find the cycle already
        // forgotten; otherwise connect() would refuse with "already connected".
        let teardownsSeenByCallback = -1;
        const { ee, calls } = setup({
            onReconnectFailed: () => {
                teardownsSeenByCallback = calls.markCycleDead;
            },
        });

        ee.emit("connect-failed", new Error("ECONNREFUSED"));
        assert.equal(calls.markCycleDead, 0, "a retriable attempt failure keeps the cycle alive");

        ee.emit("reconnect-failed", new Error("recovery exhausted"));
        assert.equal(teardownsSeenByCallback, 1, "the teardown already ran when the callback fired");
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

    it("fatal topology gate: enterFatalState + terminal reconnect-failed after setup-failed, exactly once (#201)", () => {
        const events: AmqpLifecycleEvent[] = [];
        const codeErr = Object.assign(new Error("NOT_FOUND - no queue 'q'"), { code: 404 });
        const topoErr = new AmqpTopologyError("Topology check failed (missing broker object): NOT_FOUND", { cause: codeErr });

        const { ee, calls } = setup({ onLifecycle: (event) => events.push(event) }, { fatalGate: (err) => isDeterministicTopologyDrift(err) });

        ee.emit("connect-failed", topoErr);

        assert.equal(calls.enterFatalState, 1, "fatal gate must tear the cycle down exactly once");
        assert.deepEqual(
            events.map((e) => e.type),
            ["setup-failed", "reconnect-failed"],
            "setup-failed (what failed) precedes the terminal reconnect-failed (recovery stopped)",
        );
        assert.equal((events[1] as { error?: Error }).error, topoErr);
    });

    it("fatal topology gate is suppressed while the adapter's own disconnect() is in progress (#201)", () => {
        const events: string[] = [];
        const codeErr = Object.assign(new Error("NOT_FOUND - no queue 'q'"), { code: 404 });
        const topoErr = new AmqpTopologyError("Topology check failed: NOT_FOUND", { cause: codeErr });

        const { ee, calls } = setup({ onLifecycle: (event) => events.push(event.type) }, { fatalGate: (err) => isDeterministicTopologyDrift(err), isClosing: () => true });

        ee.emit("connect-failed", topoErr);

        assert.equal(calls.enterFatalState, 0, "a racing failure must not fire terminal teardown after disconnect() started");
        assert.deepEqual(events, ["setup-failed"], "no terminal reconnect-failed during graceful shutdown");
    });

    it("fatal topology gate stays closed for non-deterministic failures (#201)", () => {
        const events: string[] = [];
        const transientErr = Object.assign(new Error("CONNECTION_FORCED - broker restarting"), { code: 320 });
        const topoWrapped = new AmqpTopologyError("Topology declaration failed: CONNECTION_FORCED", { cause: transientErr });

        const { ee, calls } = setup({ onLifecycle: (event) => events.push(event.type) }, { fatalGate: (err) => isDeterministicTopologyDrift(err) });

        ee.emit("connect-failed", topoWrapped); // transient cause wrapped as topology error
        ee.emit("connect-failed", new Error("ECONNREFUSED")); // plain network failure

        assert.equal(calls.enterFatalState, 0, "transient/network failures must stay in recovery");
        assert.deepEqual(events, ["setup-failed"], "only the topology-wrapped failure reports setup-failed; no terminal event");
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
});

describe("isAutoRetriablePublishError", () => {
    it("the AUTO-RETRY boundary is narrower than the republish matrix (#195)", () => {
        assert.equal(isAutoRetriablePublishError(new AmqpConnectionError("recovery in progress")), true, "connection-class = retriable");
        assert.equal(isAutoRetriablePublishError(new AmqpPublishTimeoutError("no outcome")), false, "timeout NOT retriable by default (state UNKNOWN)");
        assert.equal(isAutoRetriablePublishError(new AmqpPublishTimeoutError("no outcome"), { retryOnTimeout: true }), true, "timeout joins the boundary only via opt-in");
        assert.equal(isAutoRetriablePublishError(new AmqpPublishNackError("nacked"), { retryOnTimeout: true }), false, "a nack is republish-safe by POLICY but never auto-retried");
        assert.equal(isAutoRetriablePublishError(new AmqpUnroutableError("unroutable", "k"), { retryOnTimeout: true }), false, "deterministic: unroutable");
        assert.equal(isAutoRetriablePublishError(new AmqpSerializationError("bad encode"), { retryOnTimeout: true }), false, "deterministic: serialization");
        assert.equal(isAutoRetriablePublishError(new AmqpTopologyError("drift"), { retryOnTimeout: true }), false, "deterministic: topology");
        assert.equal(isAutoRetriablePublishError(new Error("raw"), { retryOnTimeout: true }), false, "raw errors never gate a retry");
    });

});

describe("computeRecoveryDelay", () => {
    // Expected values follow amqplib 2.2.0's built-in delay: the base is capped
    // at maxDelay / (1 + jitter) before the symmetric jitter, so the delay
    // never exceeds maxDelay. A copy that caps the base at maxDelay itself
    // (amqplib 2.0.1) overshoots by up to maxDelay × jitter and fails here.

    it("grows exponentially and caps the base at maxDelay / (1 + jitter)", () => {
        const opts = { initialDelay: 100, maxDelay: 400, factor: 2, jitter: 0.2 };
        // random() = 0.5 → offset 0 → the exact base.
        assert.equal(computeRecoveryDelay(opts, 1, () => 0.5), 100);
        assert.equal(computeRecoveryDelay(opts, 2, () => 0.5), 200);
        assert.equal(computeRecoveryDelay(opts, 3, () => 0.5), 333, "base saturates at 400 / 1.2, not at 400");
        assert.equal(computeRecoveryDelay(opts, 10, () => 0.5), 333);
        // Symmetric jitter bounds at saturation: the top lands exactly on maxDelay.
        assert.equal(computeRecoveryDelay(opts, 10, () => 1), 400, "the largest offset reaches maxDelay and no further");
        assert.equal(computeRecoveryDelay(opts, 10, () => 0), 267);
    });

    it("saturates within [20000, 30000] at the defaults (100 / 30000 / 2 / 0.2)", () => {
        assert.equal(computeRecoveryDelay({}, 1, () => 0.5), 100);
        assert.equal(computeRecoveryDelay({}, 20, () => 0), 20_000);
        assert.equal(computeRecoveryDelay({}, 20, () => 0.5), 25_000);
        assert.equal(computeRecoveryDelay({}, 20, () => 1), 30_000);
        // Draws near the top still spread instead of piling up on the cap.
        assert.equal(computeRecoveryDelay({}, 20, () => 0.8), 28_000);
        assert.equal(computeRecoveryDelay({}, 20, () => 0.9), 29_000);
    });

    it("jitter: 0 is exact: the base itself, capped at maxDelay", () => {
        const opts = { initialDelay: 100, maxDelay: 400, factor: 2, jitter: 0 };
        for (const r of [0, 0.3, 1]) {
            assert.equal(computeRecoveryDelay(opts, 2, () => r), 200);
            assert.equal(computeRecoveryDelay(opts, 10, () => r), 400);
        }
    });

    it("full-jitter recipe: jitter 1, initialDelay I/2, maxDelay C gives uniform [0, min(I × factor^(n−1), C)]", () => {
        const I = 200;
        const C = 1000;
        const recipe = { initialDelay: I / 2, maxDelay: C, factor: 2, jitter: 1 };
        for (let n = 1; n <= 12; n += 1) {
            const upper = Math.min(I * 2 ** (n - 1), C);
            assert.equal(computeRecoveryDelay(recipe, n, () => 0), 0, `attempt ${n}: lower bound is 0`);
            assert.equal(computeRecoveryDelay(recipe, n, () => 0.5), Math.round(upper / 2), `attempt ${n}: midpoint`);
            assert.equal(computeRecoveryDelay(recipe, n, () => 1), upper, `attempt ${n}: upper bound is min(I × 2^(n−1), C)`);
        }
    });

    it("normalizes options like amqplib: non-finite fallbacks, maxDelay ≥ initialDelay, factor ≥ 1, jitter within [0, 1]", () => {
        // Non-finite knobs fall back to the defaults instead of propagating
        // (a NaN delay would mean zero backoff — a retry storm).
        assert.equal(computeRecoveryDelay({ initialDelay: Number.NaN }, 1, () => 0.5), 100);
        assert.equal(computeRecoveryDelay({ initialDelay: Number.POSITIVE_INFINITY }, 1, () => 0.5), 100);
        assert.equal(computeRecoveryDelay({ maxDelay: Number.NaN }, 20, () => 1), 30_000);
        // factor NaN → 2, jitter NaN → 0.2: base 200, random()=1 → 200 × 1.2.
        assert.equal(computeRecoveryDelay({ factor: Number.NaN, jitter: Number.NaN }, 2, () => 1), 240);
        // Clamps.
        assert.equal(computeRecoveryDelay({ initialDelay: -5, jitter: 0 }, 3, () => 0.5), 0, "a negative initialDelay becomes 0");
        assert.equal(computeRecoveryDelay({ initialDelay: 500, maxDelay: 100, jitter: 0 }, 5, () => 0.5), 500, "maxDelay is raised to initialDelay");
        assert.equal(computeRecoveryDelay({ factor: 0.5, jitter: 0 }, 5, () => 0.5), 100, "factor below 1 becomes 1");
        assert.equal(computeRecoveryDelay({ jitter: 5 }, 1, () => 1), 200, "jitter above 1 becomes 1");
        assert.equal(computeRecoveryDelay({ jitter: -1 }, 1, () => 1), 100, "negative jitter becomes 0");
    });

    it("never returns a delay outside [0, maxDelay] over a sampled range of options, attempts and draws", () => {
        const optionSets = [
            {},
            { initialDelay: 100, maxDelay: 400, factor: 2, jitter: 0.2 },
            { initialDelay: 50, maxDelay: 1000, factor: 3, jitter: 1 },
            { initialDelay: 10, maxDelay: 777, factor: 1.5, jitter: 0.35 },
            { initialDelay: 1000, maxDelay: 1000, factor: 2, jitter: 0.5 },
            { initialDelay: 250, maxDelay: 5000, factor: 2, jitter: 0 },
        ];
        const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999, 1];
        for (const opts of optionSets) {
            const maxDelay = opts.maxDelay ?? 30_000;
            for (let attempt = 1; attempt <= 40; attempt += 1) {
                for (const r of draws) {
                    const delay = computeRecoveryDelay(opts, attempt, () => r);
                    assert.ok(delay >= 0 && delay <= maxDelay, `delay ${delay} outside [0, ${maxDelay}] for ${JSON.stringify(opts)}, attempt ${attempt}, random ${r}`);
                }
            }
        }
    });

});

describe("isDeterministicTopologyDrift", () => {
    it("404/406 reply codes on the cause are fatal, everything else is not (#201)", () => {
        const withCode = (code: number) => new AmqpTopologyError("x", { cause: Object.assign(new Error("y"), { code }) });
        assert.equal(isDeterministicTopologyDrift(withCode(404)), true, "404 NOT_FOUND = deterministic drift");
        assert.equal(isDeterministicTopologyDrift(withCode(406)), true, "406 PRECONDITION_FAILED = deterministic drift");
        assert.equal(isDeterministicTopologyDrift(withCode(320)), false, "320 connection-forced is transient");
        assert.equal(isDeterministicTopologyDrift(withCode(541)), false, "541 internal-error is transient");
        assert.equal(isDeterministicTopologyDrift(withCode(405)), false, "405 resource-locked is transient");
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x", { cause: new Error("no code") })), false, "cause without a reply code is not deterministic");
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x")), false, "no cause at all");
        assert.equal(isDeterministicTopologyDrift(Object.assign(new Error("raw"), { code: 404 })), false, "a raw non-AmqpTopologyError never gates fatal");
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x", { cause: Object.assign(new Error("y"), { code: "404" }) })), false, "string code is not a reply code");
        assert.equal(
            isDeterministicTopologyDrift(
                new AmqpTopologyError("x", {
                    cause: Object.assign(new Error("NOT_FOUND - home node 'rabbit@node1' of durable queue 'q' in vhost '/' is down or inaccessible"), { code: 404 }),
                }),
            ),
            false,
            "cluster classic-queue home-node outage is a TRANSIENT 404 — must stay in recovery",
        );
    });

});

describe("AmqpTopologyError.object", () => {
    it("AmqpTopologyError carries the failing object's identity and the cause (#202)", () => {
        const cause = new Error("PRECONDITION_FAILED");
        const err = new AmqpTopologyError("Topology declaration failed", { cause, object: { kind: "queue", name: "orders.q" } });
        assert.deepEqual(err.object, { kind: "queue", name: "orders.q" });
        assert.equal(err.cause, cause);
        assert.equal(err.name, "AmqpTopologyError");
    });

    it("AmqpTopologyError binding identity uses endpoints, not a name (#202)", () => {
        const err = new AmqpTopologyError("Topology declaration failed", {
            object: { kind: "binding", source: "orders", destination: "orders.q", destinationType: "queue", routingKey: "order.*" },
        });
        assert.deepEqual(err.object, { kind: "binding", source: "orders", destination: "orders.q", destinationType: "queue", routingKey: "order.*" });
    });

    it("AmqpTopologyError stays backward-compatible with message-only and cause-only construction (#202)", () => {
        assert.equal(new AmqpTopologyError("x").object, undefined);
        const withCause = new AmqpTopologyError("x", { cause: new Error("y") });
        assert.equal(withCause.object, undefined);
        assert.ok(withCause.cause instanceof Error);
    });

    it("AmqpTopologyError message-only construction installs NO own cause/object keys (#202 — bit-for-bit compat)", () => {
        const bare = new AmqpTopologyError("x");
        assert.equal(Object.hasOwn(bare, "cause"), false, "no own 'cause' key without a supplied cause (InstallErrorCause checks key presence)");
        assert.equal(Object.hasOwn(bare, "object"), false, "no own 'object' key without a supplied object (declare field must not emit)");
        const withObject = new AmqpTopologyError("x", { object: { kind: "queue", name: "q" } });
        assert.equal(Object.hasOwn(withObject, "object"), true);
        assert.equal(Object.hasOwn(withObject, "cause"), false, "supplying only 'object' must not install an own 'cause'");
    });

});

describe("dispatchLifecycle exception isolation", () => {
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
