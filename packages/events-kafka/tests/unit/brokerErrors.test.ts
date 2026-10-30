/**
 * Errors the broker or the socket produce without enough text to act on: a refused connection whose
 * reason is empty, and a refused topic name that is not in the message.
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { explainConnectionError, explainInvalidTopic } from "../../src/brokerErrors.ts";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";

/** The shape the client library gives a failed connection: a named error carrying the broker address and the socket's error code. */
function connectionError(message: string, fields: { broker?: string; code?: string }): Error {
    return Object.assign(new Error(message), { name: "KafkaJSConnectionError", ...fields });
}

/** The client library's wrapper for an operation whose retries ran out; its message is the cause's. */
function retriesExceeded(cause: Error): Error {
    return Object.assign(new Error(cause.message, { cause }), { name: "KafkaJSNumberOfRetriesExceeded" });
}

/** A TCP port nothing listens on: bound and released again. */
async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe("explainConnectionError", () => {
    // Node raises an AggregateError with an empty message when a host name resolves to several addresses
    // and every one refuses; the client library copies that empty message into its own.
    const emptyReason = () => {
        const cause = connectionError("Connection error: ", { broker: "localhost:1", code: "ECONNREFUSED" });
        return retriesExceeded(cause);
    };

    it("fills an empty reason with the socket error code and the broker address, on the whole chain", () => {
        const error = emptyReason();
        explainConnectionError(error);
        assert.equal(error.message, "Connection error: connect ECONNREFUSED localhost:1");
        assert.equal((error.cause as Error).message, "Connection error: connect ECONNREFUSED localhost:1");
    });

    it("says so when the socket reported neither a reason nor a code", () => {
        const cause = connectionError("Connection error: ", { broker: "b1:9092" });
        const error = retriesExceeded(cause);
        explainConnectionError(error);
        assert.equal(error.message, "Connection error: connection to b1:9092 failed, the socket gave no reason");
    });

    it("keeps the error identity and leaves a message that already has a reason untouched", () => {
        const cause = connectionError("Connection error: connect ECONNREFUSED 127.0.0.1:1", { broker: "127.0.0.1:1", code: "ECONNREFUSED" });
        const error = retriesExceeded(cause);
        explainConnectionError(error);
        assert.equal(error.message, "Connection error: connect ECONNREFUSED 127.0.0.1:1");
        assert.equal(error.name, "KafkaJSNumberOfRetriesExceeded");
    });

    it("ignores values that are not errors with a connection error in their chain", () => {
        for (const value of [undefined, null, "boom", new Error("Connection error: "), new Error("other")]) {
            assert.doesNotThrow(() => explainConnectionError(value));
        }
        const plain = new Error("Connection error: ");
        explainConnectionError(plain);
        assert.equal(plain.message, "Connection error: ");
    });
});

describe("KafkaAdapter connect() to an unreachable broker", () => {
    it("rejects with a message that names why and which address, whatever the host name resolves to", async () => {
        const port = await closedPort();
        const adapter = KafkaAdapter({ brokers: [`localhost:${port}`], logLevel: "nothing", retry: { retries: 0 } });
        await assert.rejects(adapter.connect(), (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /^Connection error: \S/, `empty reason: ${JSON.stringify(err.message)}`);
            assert.match(err.message, /ECONNREFUSED/);
            assert.ok(err.message.includes(String(port)), err.message);
            return true;
        });
    });
});

describe("explainInvalidTopic", () => {
    const refused = () => {
        const protocol = Object.assign(new Error("The request attempted to perform an operation on an invalid topic"), { name: "KafkaJSProtocolError", type: "INVALID_TOPIC_EXCEPTION" });
        return Object.assign(new Error(protocol.message, { cause: protocol }), { name: "KafkaJSNonRetriableError" });
    };

    it("names the topic and the naming rule, and keeps the original as the cause", () => {
        const original = refused();
        const explained = explainInvalidTopic("my topic*", original);
        assert.ok(explained instanceof Error);
        assert.match(explained.message, /topic "my topic\*"/);
        assert.match(explained.message, /ASCII letters, digits, "\.", "_" and "-"/);
        assert.match(explained.message, /249/);
        assert.equal(explained.cause, original);
    });

    it("returns every other failure unchanged", () => {
        const other = new Error("The leader for this topic-partition is not available");
        assert.equal(explainInvalidTopic("t", other), other);
        assert.equal(explainInvalidTopic("t", "boom"), "boom");
    });
});
