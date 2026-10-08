import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { RawEventHandler } from "@connectum/events";
import type amqp from "amqplib";
import {
    AmqpAdapter,
    buildRecoveryConnectOptions,
    classifyConfirmError,
    computeRecoveryDelay,
    createBackoffGuard,
    dispatchLifecycle,
    handleDelivery,
    isAutoRetriablePublishError,
    isBrokerClosedCurrentChannel,
    isConnectionLostError,
    isDeterministicTopologyDrift,
    normalizeInitialConnectBudget,
    normalizePublishRetryBudget,
    normalizePublishTimeout,
    resolveDisconnectCause,
    toAmqpPattern,
    trackChannelClose,
    validateSubscriptionPatterns,
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
    it("requires at least one segment after a terminal >", () => {
        assert.equal(toAmqpPattern("user.>"), "user.*.#");
        assert.equal(toAmqpPattern(">"), "*.#");
    });

    it("should preserve * for single-level wildcard", () => {
        assert.equal(toAmqpPattern("user.*"), "user.*");
    });

    it("rejects a complete > segment outside the terminal position", () => {
        assert.throws(() => toAmqpPattern(">.user.>"), /outside the terminal segment/);
        assert.throws(() => toAmqpPattern("user.>.created"), /outside the terminal segment/);
    });

    it("should return literal patterns unchanged", () => {
        assert.equal(toAmqpPattern("user.created"), "user.created");
    });

    it("preserves a single-level wildcard and translates only terminal >", () => {
        assert.equal(toAmqpPattern("*.user.>"), "*.user.*.#");
    });

    it("should handle empty string", () => {
        assert.equal(toAmqpPattern(""), "");
    });

    it("keeps wildcard characters embedded in segments literal", () => {
        assert.equal(toAmqpPattern("user>"), "user>");
        assert.equal(toAmqpPattern("user*"), "user*");
        assert.equal(toAmqpPattern("user.foo>"), "user.foo>");
    });
});

describe("validateSubscriptionPatterns", () => {
    const EXCHANGE_TYPES = ["topic", "direct", "fanout", "headers"] as const;
    const NON_TOPIC = ["direct", "fanout", "headers"] as const;

    it("accepts a literal routing key on every exchange type", () => {
        for (const type of EXCHANGE_TYPES) {
            assert.doesNotThrow(() => validateSubscriptionPatterns(["user.created"], type), type);
        }
    });

    it("accepts a single-level and a terminal multi-level wildcard on a topic exchange", () => {
        assert.doesNotThrow(() => validateSubscriptionPatterns(["user.*", "*.created", "user.>", ">"], "topic"));
    });

    it("rejects a complete > segment outside the terminal position on every exchange type", () => {
        for (const type of EXCHANGE_TYPES) {
            assert.throws(() => validateSubscriptionPatterns(["user.>.created"], type), /outside the terminal segment/, type);
            assert.throws(() => validateSubscriptionPatterns([">.user.>"], type), /outside the terminal segment/, type);
        }
    });

    it("rejects a complete # segment on a topic exchange, wherever it stands", () => {
        for (const pattern of ["#", "user.#", "#.created", "user.#.created"]) {
            assert.throws(() => validateSubscriptionPatterns([pattern], "topic"), /contains "#", which RabbitMQ treats as a wildcard/, pattern);
        }
    });

    it("keeps # literal on non-topic exchanges", () => {
        for (const type of NON_TOPIC) {
            assert.doesNotThrow(() => validateSubscriptionPatterns(["#", "user.#"], type), type);
        }
    });

    it("rejects a complete * or terminal > on every non-topic exchange, naming the configured type", () => {
        for (const type of NON_TOPIC) {
            for (const pattern of ["user.*", "*", "user.>", ">"]) {
                assert.throws(
                    () => validateSubscriptionPatterns([pattern], type),
                    (err: unknown) => err instanceof TypeError && err.message === `AMQP wildcard subscription pattern "${pattern}" requires a topic exchange; configured exchange type is "${type}"`,
                    `${type} ${pattern}`,
                );
            }
        }
    });

    it("treats wildcard characters embedded in a segment as literal on every exchange type", () => {
        for (const type of EXCHANGE_TYPES) {
            assert.doesNotThrow(() => validateSubscriptionPatterns(["user>", "user*", "user#", "user.foo>", "a*b.c"], type), type);
        }
    });

    it("fails the whole call when any one pattern is invalid", () => {
        assert.throws(() => validateSubscriptionPatterns(["user.created", "user.#"], "topic"), /contains "#"/);
        assert.throws(() => validateSubscriptionPatterns(["user.created", "user.*"], "direct"), /requires a topic exchange/);
    });

    it("accepts an empty pattern list", () => {
        for (const type of EXCHANGE_TYPES) {
            assert.doesNotThrow(() => validateSubscriptionPatterns([], type), type);
        }
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
    const reply = (code: number | string, text: string) => new AmqpTopologyError("x", { cause: Object.assign(new Error(text), { code }) });

    it("a missing queue or exchange (404) is fatal", () => {
        assert.equal(isDeterministicTopologyDrift(reply(404, "Operation failed: QueueDeclare; NOT_FOUND - no queue 'q' in vhost '/'")), true);
        assert.equal(isDeterministicTopologyDrift(reply(404, "Channel closed by server: 404 (NOT_FOUND) with message \"NOT_FOUND - no exchange 'ex' in vhost '/'\"")), true);
    });

    it("a redeclare with different or invalid arguments, or a bad exchange type (406), is fatal", () => {
        assert.equal(
            isDeterministicTopologyDrift(
                reply(406, "PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q' in vhost '/': received 'false' but current is 'true'"),
            ),
            true,
        );
        assert.equal(isDeterministicTopologyDrift(reply(406, "PRECONDITION_FAILED - invalid arg 'x-max-length' for queue 'q' in vhost '/'")), true);
        assert.equal(isDeterministicTopologyDrift(reply(406, "PRECONDITION_FAILED - unknown exchange type 'bogus'")), true);
        assert.equal(isDeterministicTopologyDrift(reply(406, "PRECONDITION_FAILED - invalid exchange type 'bogus'")), true);
    });

    it("every self-healing 404 keeps the cycle in recovery", () => {
        const transient = [
            "NOT_FOUND - home node 'rabbit@node1' of durable queue 'q' in vhost '/' is down or inaccessible",
            "NOT_FOUND - queue 'q' in vhost '/' process is stopped by supervisor",
            "NOT_FOUND - queue 'q' in vhost '/' crashed and failed to restart",
            "NOT_FOUND - timed out while declaring queue 'q' in vhost '/'",
            "NOT_FOUND - leader of queue 'q' in vhost '/' may be stopping or being demoted",
        ];
        for (const text of transient) {
            assert.equal(isDeterministicTopologyDrift(reply(404, text)), false, text);
        }
    });

    it("a 406 that clears on its own (exchange limit) is not fatal", () => {
        assert.equal(isDeterministicTopologyDrift(reply(406, "PRECONDITION_FAILED - cannot declare exchange 'ex' in vhost '/': exchange limit of 10 reached")), false);
    });

    it("other reply codes are never fatal", () => {
        for (const code of [320, 541, 405, 403]) {
            assert.equal(isDeterministicTopologyDrift(reply(code, "no queue 'q' inequivalent arg")), false, `code ${code}`);
        }
    });

    it("a recognised code without a recognised text, or without any text, is not fatal", () => {
        assert.equal(isDeterministicTopologyDrift(reply(404, "y")), false, "unrecognised 404 text");
        assert.equal(isDeterministicTopologyDrift(reply(406, "y")), false, "unrecognised 406 text");
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x", { cause: { code: 404 } })), false, "cause object without a message");
    });

    it("malformed causes and non-topology errors never gate fatal", () => {
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x", { cause: new Error("no code") })), false, "cause without a reply code");
        assert.equal(isDeterministicTopologyDrift(new AmqpTopologyError("x")), false, "no cause at all");
        assert.equal(isDeterministicTopologyDrift(Object.assign(new Error("no queue 'q'"), { code: 404 })), false, "a raw non-AmqpTopologyError");
        assert.equal(isDeterministicTopologyDrift(reply("404", "no queue 'q'")), false, "string code is not a reply code");
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
        assert.deepEqual(union, ["disconnected", "lifecycle-error"], "the original event is delivered first, then the isolated failure is reported");
    });

    it("isolates an async onLifecycle that rejects: no unhandledRejection, flat shim still fires, failure reported", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            const reports: AmqpLifecycleEvent[] = [];
            let flatFired = 0;
            const lifecycle: AmqpLifecycleCallbacks = {
                onLifecycle: async (event) => {
                    if (event.type === "lifecycle-error") {
                        reports.push(event);
                        return;
                    }
                    throw new Error("async metrics bug");
                },
                onConnected: () => {
                    flatFired += 1;
                },
            };

            dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
            await new Promise<void>((resolve) => setImmediate(resolve));
            await new Promise<void>((resolve) => setImmediate(resolve));

            assert.equal(flatFired, 1);
            assert.equal(unhandled.length, 0, "a rejected callback promise must not become an unhandledRejection");
            assert.equal(reports.length, 1);
            const report = reports[0];
            assert.ok(report?.type === "lifecycle-error");
            assert.equal(report.callback, "onLifecycle");
            assert.equal(report.event, "connected");
            assert.equal(report.error.message, "async metrics bug");
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("isolates an async flat callback that rejects and reports it under the flat callback's name", async () => {
        const reports: AmqpLifecycleEvent[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => {
                if (event.type === "lifecycle-error") {
                    reports.push(event);
                }
            },
            onReconnecting: async () => {
                throw new Error("boom");
            },
        };

        dispatchLifecycle(lifecycle, { type: "reconnecting", attempt: 1, delay: 100, error: new Error("drop") });
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(reports.length, 1);
        const report = reports[0];
        assert.ok(report?.type === "lifecycle-error");
        assert.equal(report.callback, "onReconnecting");
        assert.equal(report.event, "reconnecting");
        assert.equal(report.error.message, "boom");
    });

    it("isolates a callback that returns a rejecting thenable which is not a native Promise", async () => {
        const reports: AmqpLifecycleEvent[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => {
                if (event.type === "lifecycle-error") {
                    reports.push(event);
                }
            },
            onConnected: (() => ({
                then: (_onFulfilled: unknown, onRejected: (reason: unknown) => void) => {
                    onRejected(new Error("thenable boom"));
                },
            })) as unknown as () => void,
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(reports.length, 1);
        const report = reports[0];
        assert.ok(report?.type === "lifecycle-error");
        assert.equal(report.callback, "onConnected");
        assert.equal(report.error.message, "thenable boom");
    });

    it("does not invoke onLifecycle a second time for an event whose flat callback failed", () => {
        const seen: string[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => {
                seen.push(event.type);
            },
            onConnected: () => {
                throw new Error("flat bug");
            },
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });

        assert.deepEqual(seen, ["connected", "lifecycle-error"], "exactly one original delivery plus one diagnostic");
    });

    it("drops a failure of the lifecycle-error handler itself instead of recursing", () => {
        let calls = 0;
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: () => {
                calls += 1;
                throw new Error("always");
            },
        };

        assert.doesNotThrow(() => dispatchLifecycle(lifecycle, { type: "connected", reconnected: false }));
        assert.equal(calls, 2, "one call for the original event, one for its lifecycle-error — then the chain stops");
    });

    it("drops an async failure of the lifecycle-error handler instead of recursing", async () => {
        let calls = 0;
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: async () => {
                calls += 1;
                throw new Error("always");
            },
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(calls, 2);
    });

    it("wraps a non-Error thrown value in an Error that keeps the original as cause", () => {
        const reports: AmqpLifecycleEvent[] = [];
        const lifecycle: AmqpLifecycleCallbacks = {
            onLifecycle: (event) => {
                if (event.type === "lifecycle-error") {
                    reports.push(event);
                }
            },
            onConnected: () => {
                throw "plain string";
            },
        };

        dispatchLifecycle(lifecycle, { type: "connected", reconnected: false });

        const report = reports[0];
        assert.ok(report?.type === "lifecycle-error");
        assert.ok(report.error instanceof Error);
        assert.equal(report.error.message, "plain string");
        assert.equal(report.error.cause, "plain string");
    });

    it("never invokes a flat callback for lifecycle-error or settlement-skipped", () => {
        let flat = 0;
        const bump = (): void => {
            flat += 1;
        };
        const lifecycle: AmqpLifecycleCallbacks = {
            onConnected: bump,
            onDisconnected: bump,
            onReconnecting: bump,
            onReconnectFailed: bump,
            onSetupFailed: bump,
        };

        dispatchLifecycle(lifecycle, { type: "lifecycle-error", callback: "onLifecycle", event: "connected", error: new Error("x") });
        dispatchLifecycle(lifecycle, { type: "settlement-skipped", action: "ack", queue: "q", routingKey: "r", deliveryTag: 1, error: new Error("x") });

        assert.equal(flat, 0);
    });
});

describe("resolveDisconnectCause", () => {
    it("passes the broker's close error through with its reply code (forced close, 320)", () => {
        const closeError = Object.assign(new Error("Connection closed: 320 (CONNECTION-FORCED)"), { code: 320 });
        const resolved = resolveDisconnectCause(null, closeError);
        assert.equal(resolved, closeError);
        assert.equal((resolved as { code?: number }).code, 320);
    });

    it("prefers an earlier connection error over the close error", () => {
        const early = new Error("ECONNRESET");
        const closeError = Object.assign(new Error("Connection closed"), { code: 320 });
        assert.equal(resolveDisconnectCause(early, closeError), early);
    });

    it("falls back to a generic error when the close carried no cause", () => {
        assert.equal(resolveDisconnectCause(null, undefined).message, "Connection closed");
    });

    it("does not trust a close value that is not an Error", () => {
        assert.equal(resolveDisconnectCause(null, "boom").message, "Connection closed");
        assert.equal(resolveDisconnectCause(null, { code: 320 }).message, "Connection closed");
    });
});

describe("isBrokerClosedCurrentChannel", () => {
    const makeChannel = (): amqp.ConfirmChannel => ({}) as unknown as amqp.ConfirmChannel;
    const closedWith = (channel: amqp.ConfirmChannel, code: unknown): WeakMap<amqp.ConfirmChannel, Error> =>
        new WeakMap([[channel, Object.assign(new Error("Channel closed by server"), { code })]]);

    it("stops on any broker reply code that closed the current channel: 403, 404, 406, 541", () => {
        for (const code of [403, 404, 406, 541]) {
            const channel = makeChannel();
            assert.equal(isBrokerClosedCurrentChannel(channel, channel, closedWith(channel, code)), true, `code ${code}`);
        }
    });

    it("keeps retrying when the channel recovery has already replaced produced the code", () => {
        const attempted = makeChannel();
        const replacement = makeChannel();
        assert.equal(isBrokerClosedCurrentChannel(attempted, replacement, closedWith(attempted, 404)), false);
    });

    it("keeps retrying when the channel died with the connection and recorded no reply code", () => {
        const channel = makeChannel();
        const lost = new WeakMap<amqp.ConfirmChannel, Error>([[channel, new Error("channel closed")]]);
        assert.equal(isBrokerClosedCurrentChannel(channel, channel, lost), false);
        assert.equal(isBrokerClosedCurrentChannel(channel, channel, new WeakMap()), false, "no recorded error at all");
    });

    it("ignores a non-numeric code", () => {
        const channel = makeChannel();
        assert.equal(isBrokerClosedCurrentChannel(channel, channel, closedWith(channel, "404")), false);
    });

    it("has nothing to judge without an attempted channel", () => {
        const channel = makeChannel();
        assert.equal(isBrokerClosedCurrentChannel(null, channel, closedWith(channel, 404)), false);
        assert.equal(isBrokerClosedCurrentChannel(null, null, new WeakMap()), false);
    });
});

describe("handleDelivery settlement on a closed channel", () => {
    const closedChannelError = (): Error => Object.assign(new Error("Channel closed"), { name: "IllegalOperationError" });

    const makeMessage = (overrides?: { redelivered?: boolean; content?: Buffer }): amqp.ConsumeMessage =>
        ({
            content: overrides?.content ?? Buffer.from("payload"),
            fields: { deliveryTag: 7, redelivered: overrides?.redelivered ?? false, exchange: "ex", routingKey: "orders.created", consumerTag: "ctag" },
            properties: { headers: {}, messageId: "m1" },
        }) as unknown as amqp.ConsumeMessage;

    const closedChannel = (calls: string[]) => ({
        ack: () => {
            calls.push("ack");
            throw closedChannelError();
        },
        nack: (_message: amqp.Message, _allUpTo: boolean, requeue: boolean) => {
            calls.push(requeue ? "nack-requeue" : "nack-reject");
            throw closedChannelError();
        },
    });

    const collect = (): { events: AmqpLifecycleEvent[]; lifecycle: AmqpLifecycleCallbacks } => {
        const events: AmqpLifecycleEvent[] = [];
        return { events, lifecycle: { onLifecycle: (event) => events.push(event) } };
    };

    const settle = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it("a rejecting handler on a closed channel requeues quietly and reports settlement-skipped", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            const calls: string[] = [];
            const { events, lifecycle } = collect();

            handleDelivery({
                channel: closedChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async () => {
                    throw new Error("handler failed");
                },
                decode: undefined,
                lifecycle,
            });
            await settle();
            await settle();

            assert.deepEqual(calls, ["nack-requeue"]);
            assert.equal(unhandled.length, 0, "the requeue after a rejected handler must not raise unhandledRejection on a closed channel");
            assert.equal(events.length, 1);
            const event = events[0];
            assert.ok(event?.type === "settlement-skipped");
            assert.equal(event.action, "requeue");
            assert.equal(event.queue, "orders");
            assert.equal(event.routingKey, "orders.created");
            assert.equal(event.deliveryTag, 7);
            assert.equal(event.error.name, "IllegalOperationError");
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("an explicit ack() on a closed channel resolves and reports one settlement-skipped; later settlements are silent no-ops", async () => {
        const calls: string[] = [];
        const { events, lifecycle } = collect();
        const results: string[] = [];

        handleDelivery({
            channel: closedChannel(calls),
            message: makeMessage(),
            queue: "orders",
            handler: async (_event, ack, nack) => {
                await ack();
                results.push("ack-resolved");
                await nack(false);
                results.push("reject-resolved");
                await nack();
                results.push("requeue-resolved");
            },
            decode: undefined,
            lifecycle,
        });
        await settle();

        assert.deepEqual(results, ["ack-resolved", "reject-resolved", "requeue-resolved"]);
        assert.deepEqual(calls, ["ack"]);
        assert.deepEqual(
            events.map((event) => (event.type === "settlement-skipped" ? event.action : event.type)),
            ["ack"],
        );
    });

    it("an undecodable payload on a closed channel does not throw out of the consume callback", () => {
        const calls: string[] = [];
        const { events, lifecycle } = collect();

        assert.doesNotThrow(() =>
            handleDelivery({
                channel: closedChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async () => undefined,
                decode: () => {
                    throw new Error("bad payload");
                },
                lifecycle,
            }),
        );

        assert.deepEqual(calls, ["nack-reject"]);
        const event = events[0];
        assert.ok(event?.type === "settlement-skipped");
        assert.equal(event.action, "reject");
    });

    it("an open channel settles without any diagnostic event", async () => {
        const calls: string[] = [];
        const { events, lifecycle } = collect();

        handleDelivery({
            channel: {
                ack: () => {
                    calls.push("ack");
                },
                nack: (_message, _allUpTo, requeue) => {
                    calls.push(requeue ? "nack-requeue" : "nack-reject");
                },
            },
            message: makeMessage(),
            queue: "orders",
            handler: async (_event, ack) => {
                await ack();
            },
            decode: undefined,
            lifecycle,
        });
        await settle();

        assert.deepEqual(calls, ["ack"]);
        assert.equal(events.length, 0);
    });

    it("an error that is not a closed channel is not hidden from an explicit ack()", async () => {
        const { events, lifecycle } = collect();
        let handlerSaw: unknown;

        handleDelivery({
            channel: {
                ack: () => {
                    throw new TypeError("not a channel problem");
                },
                nack: () => undefined,
            },
            message: makeMessage(),
            queue: "orders",
            handler: async (_event, ack) => {
                try {
                    await ack();
                } catch (error) {
                    handlerSaw = error;
                }
            },
            decode: undefined,
            lifecycle,
        });
        await settle();

        assert.ok(handlerSaw instanceof TypeError);
        assert.equal(events.length, 0, "only a closed channel is reported as a skipped settlement");
    });

    it("a failed settlement that is not a closed channel does not count as settled, so the fallback requeue still runs", async () => {
        const calls: string[] = [];
        let failFirst = true;

        handleDelivery({
            channel: {
                ack: () => {
                    calls.push("ack");
                    if (failFirst) {
                        failFirst = false;
                        throw new TypeError("not a channel problem");
                    }
                },
                nack: (_message, _allUpTo, requeue) => {
                    calls.push(requeue ? "nack-requeue" : "nack-reject");
                },
            },
            message: makeMessage(),
            queue: "orders",
            handler: async (_event, ack) => {
                await ack();
            },
            decode: undefined,
            lifecycle: undefined,
        });
        await settle();
        await settle();

        assert.deepEqual(calls, ["ack", "nack-requeue"]);
    });

    describe("a delivery is settled at most once", () => {
        const openChannel = (calls: string[]) => ({
            ack: () => {
                calls.push("ack");
            },
            nack: (_message: amqp.Message, _allUpTo: boolean, requeue: boolean) => {
                calls.push(requeue ? "nack-requeue" : "nack-reject");
            },
        });

        it("the first of ack(), nack(false) and nack() wins and the rest resolve without reaching the channel", async () => {
            const calls: string[] = [];
            const { events, lifecycle } = collect();
            const results: string[] = [];

            handleDelivery({
                channel: openChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async (_event, ack, nack) => {
                    await ack();
                    await nack(false);
                    results.push("reject-resolved");
                    await nack();
                    results.push("requeue-resolved");
                    await ack();
                    results.push("ack-resolved");
                },
                decode: undefined,
                lifecycle,
            });
            await settle();

            assert.deepEqual(calls, ["ack"]);
            assert.deepEqual(results, ["reject-resolved", "requeue-resolved", "ack-resolved"]);
            assert.equal(events.length, 0, "a repeated settlement is silent");
        });

        it("nack(false) first keeps the rejection when the handler then calls ack()", async () => {
            const calls: string[] = [];

            handleDelivery({
                channel: openChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async (_event, ack, nack) => {
                    await nack(false);
                    await ack();
                },
                decode: undefined,
                lifecycle: undefined,
            });
            await settle();

            assert.deepEqual(calls, ["nack-reject"]);
        });

        for (const first of ["ack", "reject", "requeue"] as const) {
            it(`a handler that settles with ${first} and then throws is not requeued again`, async () => {
                const unhandled: unknown[] = [];
                const onUnhandled = (reason: unknown): void => {
                    unhandled.push(reason);
                };
                process.on("unhandledRejection", onUnhandled);
                try {
                    const calls: string[] = [];
                    const { events, lifecycle } = collect();

                    handleDelivery({
                        channel: openChannel(calls),
                        message: makeMessage(),
                        queue: "orders",
                        handler: async (_event, ack, nack) => {
                            if (first === "ack") {
                                await ack();
                            } else {
                                await nack(first === "requeue");
                            }
                            throw new Error("failed after settling");
                        },
                        decode: undefined,
                        lifecycle,
                    });
                    await settle();
                    await settle();

                    const expected = { ack: "ack", reject: "nack-reject", requeue: "nack-requeue" }[first];
                    assert.deepEqual(calls, [expected]);
                    assert.equal(events.length, 0);
                    assert.equal(unhandled.length, 0);
                } finally {
                    process.off("unhandledRejection", onUnhandled);
                }
            });
        }

        it("a handler that throws without settling is requeued exactly once", async () => {
            const calls: string[] = [];

            handleDelivery({
                channel: openChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async () => {
                    throw new Error("failed before settling");
                },
                decode: undefined,
                lifecycle: undefined,
            });
            await settle();
            await settle();

            assert.deepEqual(calls, ["nack-requeue"]);
        });

        it("an ack() skipped on a closed channel is not retried by the requeue after a later throw", async () => {
            const calls: string[] = [];
            const { events, lifecycle } = collect();

            handleDelivery({
                channel: closedChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async (_event, ack) => {
                    await ack();
                    throw new Error("failed after settling");
                },
                decode: undefined,
                lifecycle,
            });
            await settle();
            await settle();

            assert.deepEqual(calls, ["ack"]);
            assert.equal(events.length, 1);
        });
    });

    it("works without any lifecycle callbacks", async () => {
        const calls: string[] = [];

        assert.doesNotThrow(() =>
            handleDelivery({
                channel: closedChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: async () => {
                    throw new Error("handler failed");
                },
                decode: undefined,
                lifecycle: undefined,
            }),
        );
        await settle();

        assert.deepEqual(calls, ["nack-requeue"]);
    });
});

describe("handleDelivery never lets a failure escape the consume callback", () => {
    const makeMessage = (): amqp.ConsumeMessage =>
        ({
            content: Buffer.from("payload"),
            fields: { deliveryTag: 7, redelivered: false, exchange: "ex", routingKey: "orders.created", consumerTag: "ctag" },
            properties: { headers: {}, messageId: "m1" },
        }) as unknown as amqp.ConsumeMessage;

    const settle = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    const recordingChannel = (calls: string[], failWith?: Error) => ({
        ack: () => {
            calls.push("ack");
            if (failWith) {
                throw failWith;
            }
        },
        nack: (_message: amqp.Message, _allUpTo: boolean, requeue: boolean) => {
            calls.push(requeue ? "nack-requeue" : "nack-reject");
            if (failWith) {
                throw failWith;
            }
        },
    });

    const watchUnhandled = (): { unhandled: unknown[]; stop: () => void } => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        return { unhandled, stop: () => process.off("unhandledRejection", onUnhandled) };
    };

    it("a handler that throws synchronously is requeued once and nothing is thrown to the caller", async () => {
        const calls: string[] = [];
        const events: AmqpLifecycleEvent[] = [];

        assert.doesNotThrow(() =>
            handleDelivery({
                channel: recordingChannel(calls),
                message: makeMessage(),
                queue: "orders",
                handler: (() => {
                    throw new Error("synchronous failure");
                }) as unknown as RawEventHandler,
                decode: undefined,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            }),
        );
        await settle();

        assert.deepEqual(calls, ["nack-requeue"]);
        assert.equal(events.length, 0);
    });

    it("a handler that throws synchronously after an explicit ack() sends no requeue", async () => {
        const calls: string[] = [];

        handleDelivery({
            channel: recordingChannel(calls),
            message: makeMessage(),
            queue: "orders",
            handler: async (_event, ack) => {
                await ack();
                throw new Error("failure after ack");
            },
            decode: undefined,
            lifecycle: undefined,
        });
        await settle();

        assert.deepEqual(calls, ["ack"]);
    });

    it("a requeue that fails for a reason other than a closed channel is reported as settlement-skipped, not left unhandled", async () => {
        const watch = watchUnhandled();
        try {
            const calls: string[] = [];
            const events: AmqpLifecycleEvent[] = [];

            handleDelivery({
                channel: recordingChannel(calls, new TypeError("broker refused")),
                message: makeMessage(),
                queue: "orders",
                handler: async () => {
                    throw new Error("handler failed");
                },
                decode: undefined,
                lifecycle: { onLifecycle: (event) => events.push(event) },
            });
            await settle();
            await settle();

            assert.deepEqual(calls, ["nack-requeue"]);
            assert.equal(watch.unhandled.length, 0, "the fallback requeue must not raise unhandledRejection");
            assert.equal(events.length, 1);
            const event = events[0];
            assert.ok(event?.type === "settlement-skipped");
            assert.equal(event.action, "requeue");
            assert.ok(event.error instanceof TypeError);
        } finally {
            watch.stop();
        }
    });

    it("a reject of an undecodable payload that fails for another reason is reported, not thrown to the caller", () => {
        const calls: string[] = [];
        const events: AmqpLifecycleEvent[] = [];

        assert.doesNotThrow(() =>
            handleDelivery({
                channel: recordingChannel(calls, new TypeError("broker refused")),
                message: makeMessage(),
                queue: "orders",
                handler: async () => undefined,
                decode: () => {
                    throw new Error("bad payload");
                },
                lifecycle: { onLifecycle: (event) => events.push(event) },
            }),
        );

        assert.deepEqual(calls, ["nack-reject"]);
        const event = events[0];
        assert.ok(event?.type === "settlement-skipped");
        assert.equal(event.action, "reject");
        assert.ok(event.error instanceof TypeError);
    });
});

describe("normalizePublishTimeout", () => {
    it("keeps a usable finite value, flooring a fraction", () => {
        assert.equal(normalizePublishTimeout(1), 1);
        assert.equal(normalizePublishTimeout(5_000), 5_000);
        assert.equal(normalizePublishTimeout(1_500.9), 1_500);
    });

    it("falls back to the 30 s default for a value setTimeout would fire at once", () => {
        // NaN, Infinity and anything below 1 make setTimeout run the callback
        // after about 1 ms, which would time out every publish.
        assert.equal(normalizePublishTimeout(Number.NaN), 30_000);
        assert.equal(normalizePublishTimeout(Number.POSITIVE_INFINITY), 30_000);
        assert.equal(normalizePublishTimeout(Number.NEGATIVE_INFINITY), 30_000);
        assert.equal(normalizePublishTimeout(0), 30_000);
        assert.equal(normalizePublishTimeout(-5), 30_000);
        assert.equal(normalizePublishTimeout(0.5), 30_000);
        assert.equal(normalizePublishTimeout("5000"), 30_000);
        assert.equal(normalizePublishTimeout(undefined), 30_000);
    });

    it("caps a value above the timer limit instead of letting it wrap to 1 ms", () => {
        assert.equal(normalizePublishTimeout(2_147_483_647), 2_147_483_647);
        assert.equal(normalizePublishTimeout(2_147_483_648), 2_147_483_647);
        assert.equal(normalizePublishTimeout(Number.MAX_SAFE_INTEGER), 2_147_483_647);
    });
});

describe("normalizePublishRetryBudget", () => {
    it("clamps a negative or fractional budget to a non-negative integer", () => {
        assert.equal(normalizePublishRetryBudget(-1), 0);
        assert.equal(normalizePublishRetryBudget(0), 0);
        assert.equal(normalizePublishRetryBudget(3.9), 3);
    });

    it("keeps +Infinity and reads -Infinity as an empty budget", () => {
        assert.equal(normalizePublishRetryBudget(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
        assert.equal(normalizePublishRetryBudget(Number.NEGATIVE_INFINITY), 0);
    });

    it("uses the default of 5 for a value that is not a number", () => {
        assert.equal(normalizePublishRetryBudget(Number.NaN), 5);
        assert.equal(normalizePublishRetryBudget(undefined), 5);
        assert.equal(normalizePublishRetryBudget("3"), 5);
    });
});
