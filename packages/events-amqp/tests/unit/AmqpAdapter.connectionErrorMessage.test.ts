/**
 * A failed connect to a hostname with several addresses is reported by Node as
 * an `AggregateError` with an empty message. The adapter must not pass it on
 * unchanged as the `cause` of its own error, nor through a lifecycle event:
 * the reason and the addresses have to be readable.
 */

import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { describe, it } from "node:test";
import { explainAggregateError } from "../../src/AmqpAdapter.ts";
import { AmqpAdapter, AmqpConnectionError, type AmqpLifecycleEvent } from "../../src/index.ts";

describe("explainAggregateError", () => {
    it("fills an empty message with the members' messages, keeping the class, code and members", () => {
        const first = Object.assign(new Error("connect ECONNREFUSED ::1:1"), { code: "ECONNREFUSED" });
        const second = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
        const aggregate = Object.assign(new AggregateError([first, second], ""), { code: "ECONNREFUSED" });

        const result = explainAggregateError(aggregate);

        assert.equal(result, aggregate, "the same object, so callers matching on its class or code are unaffected");
        assert.ok(result instanceof AggregateError);
        assert.equal(result.message, "connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
        assert.equal((result as { code?: string }).code, "ECONNREFUSED");
        assert.deepEqual(result.errors, [first, second]);
    });

    it("names a member that is not an Error or has no message by its string form", () => {
        const aggregate = new AggregateError([new Error(""), "plain failure"], "");
        assert.equal(explainAggregateError(aggregate).message, "Error; plain failure");
    });

    it("leaves an aggregate that already has a message, an empty aggregate, and other values alone", () => {
        const described = new AggregateError([new Error("x")], "own text");
        assert.equal(explainAggregateError(described).message, "own text");
        const empty = new AggregateError([], "");
        assert.equal(explainAggregateError(empty).message, "");
        const plain = new Error("");
        assert.equal(explainAggregateError(plain), plain);
        assert.equal(explainAggregateError("text"), "text");
        assert.equal(explainAggregateError(undefined), undefined);
    });
});

/**
 * `localhost` yields an `AggregateError` only where it resolves to more than
 * one address (IPv6 and IPv4). Elsewhere the same failure already names its
 * address and there is nothing to assert.
 */
const localhostAddresses = await lookup("localhost", { all: true }).then(
    (addresses) => addresses.length,
    () => 0,
);

describe("a connect failure against a multi-address hostname", { skip: localhostAddresses > 1 ? false : "localhost resolves to a single address" }, () => {
    const URL = "amqp://localhost:1";
    const NAMES_ADDRESS = /ECONNREFUSED/;

    it("initialConnectMaxRetries: the AmqpConnectionError cause states the reason and the address", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url: URL, recovery: { initialConnectMaxRetries: 1, initialDelay: 5, maxDelay: 10 } });
        const error = await adapter.connect().then(
            () => null,
            (e: unknown) => e,
        );
        assert.ok(error instanceof AmqpConnectionError);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, NAMES_ADDRESS);
    });

    it("a finite maxRetries without a startup budget: the give-up error's cause is readable", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url: URL, recovery: { maxRetries: 1, initialDelay: 5, maxDelay: 10 } });
        const error = await adapter.connect().then(
            () => null,
            (e: unknown) => e,
        );
        assert.ok(error instanceof AmqpConnectionError);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, NAMES_ADDRESS);
    });

    it("recovery: false: the thrown error keeps its class and gains a message", { timeout: 20_000 }, async () => {
        const adapter = AmqpAdapter({ url: URL, recovery: false });
        const error = await adapter.connect().then(
            () => null,
            (e: unknown) => e,
        );
        assert.ok(error instanceof AggregateError, "the raw error is still thrown unchanged in kind");
        assert.match(error.message, NAMES_ADDRESS);
    });

    it("the reconnecting lifecycle event carries a readable error", { timeout: 20_000 }, async () => {
        const events: AmqpLifecycleEvent[] = [];
        const adapter = AmqpAdapter({
            url: URL,
            recovery: { initialConnectMaxRetries: 2, initialDelay: 5, maxDelay: 10 },
            lifecycle: { onLifecycle: (event) => events.push(event) },
        });
        await adapter.connect().catch(() => undefined);
        const reconnecting = events.filter((event) => event.type === "reconnecting");
        assert.ok(reconnecting.length > 0, "the bounded initial window reports each retry");
        for (const event of reconnecting) {
            assert.match(event.error.message, NAMES_ADDRESS);
        }
    });
});
