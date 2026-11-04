import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainTimeout, showServers, showTopic, showTopics } from "../../src/timeouts.ts";

describe("showServers", () => {
    it("leaves a server without credentials as it is", () => {
        assert.equal(showServers(["nats://localhost:4222", "tls://nats.example.com:4222", "localhost:4222", "[::1]:4222"]), "nats://localhost:4222, tls://nats.example.com:4222, localhost:4222, [::1]:4222");
    });

    it("removes user and password, a token, and credentials without a scheme", () => {
        assert.equal(showServers(["nats://svc:s3cret@host:4222", "nats://t0ken@host:4222", "svc:s3cret@host:4222"]), "nats://host:4222, nats://host:4222, host:4222");
    });

    it("removes the whole credentials part when the password contains an unescaped @", () => {
        const server = "nats://svc:@s3cret@127.0.0.1:4222";
        // The URL parser the client uses ends the credentials at the last "@": the host is what follows it.
        assert.equal(new URL(server).hostname, "127.0.0.1");
        assert.equal(showServers([server]), "nats://127.0.0.1:4222");
    });

    it("keeps an @ that belongs to the path", () => {
        assert.equal(showServers(["nats://host:4222/a@b"]), "nats://host:4222/a@b");
    });
});

describe("showTopic and showTopics", () => {
    it("quotes a short topic and cuts a long one with its length", () => {
        assert.equal(showTopic("orders.created"), '"orders.created"');
        assert.equal(showTopic("a".repeat(100)), `"${"a".repeat(100)}"`);
        assert.equal(showTopic("a".repeat(101)), `"${"a".repeat(100)}... (101 characters)"`);
    });

    it("lists up to five topics and counts the rest", () => {
        assert.equal(showTopics(["a", "b"]), '["a", "b"]');
        assert.equal(showTopics(["a", "b", "c", "d", "e", "f", "g"]), '["a", "b", "c", "d", "e", and 2 more]');
    });
});

describe("explainTimeout", () => {
    it("rewrites the message of a TimeoutError once and keeps the class and the cause", () => {
        const cause = new Error("root");
        const error = Object.assign(new Error("timeout", { cause }), { name: "TimeoutError" });
        explainTimeout(error, "publish to topic x was not acknowledged in time");
        explainTimeout(error, "something else");
        assert.equal(error.message, "NatsAdapter: publish to topic x was not acknowledged in time: timeout");
        assert.equal(error.name, "TimeoutError");
        assert.equal(error.cause, cause);
    });

    it("leaves other errors and other values alone", () => {
        const other = new Error("connection closed");
        explainTimeout(other, "publish");
        explainTimeout("timeout", "publish");
        explainTimeout(undefined, "publish");
        assert.equal(other.message, "connection closed");
    });
});
