import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

describe("NatsAdapter", () => {
    it("should throw when publishing without connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        await assert.rejects(
            () => adapter.publish("test.event", new Uint8Array([1, 2, 3])),
            { message: "NatsAdapter: not connected" },
        );
    });

    it("should throw when subscribing without connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        await assert.rejects(
            () => adapter.subscribe(["test.>"], async () => {}),
            { message: "NatsAdapter: not connected" },
        );
    });

    it("should not throw when disconnecting without prior connection", async () => {
        const adapter = NatsAdapter({ servers: "nats://localhost:4222" });
        // disconnect() should be a no-op when not connected
        await adapter.disconnect();
    });
});

/**
 * A stand-in for a NATS server that only reads the client's CONNECT message and then drops the
 * connection: the adapter's connect() rejects, and what it announced about itself is recorded.
 * Nothing here depends on JetStream, so no broker is needed.
 */
async function announcedConnectOptions(run: (url: string) => Promise<void>): Promise<Record<string, unknown>> {
    let announced: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.write('INFO {"server_id":"stand-in","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576,"jetstream":true}\r\n');
        let received = "";
        socket.on("data", (chunk) => {
            received += chunk.toString();
            const line = received.split("\r\n").find((candidate) => candidate.startsWith("CONNECT "));
            if (line !== undefined && announced === undefined) {
                announced = JSON.parse(line.slice("CONNECT ".length)) as Record<string, unknown>;
                socket.destroy();
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        await run(`nats://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.ok(announced, "the client must have sent its CONNECT message");
    return announced;
}

/** The stand-in drops every connection, so the client must not keep reconnecting or waiting. */
const GIVE_UP_AT_ONCE = { reconnect: false, timeout: 2_000 } as const;

describe("NatsAdapter connection name", () => {
    // The events guide: the EventBus derives a service identifier that adapters use for the broker
    // connection name (NATS connection `name`), and an explicit adapter option always wins.

    it("announces the service identifier given to connect() as the connection name", async () => {
        const announced = await announcedConnectOptions(async (url) => {
            const adapter = NatsAdapter({ servers: url, connectionOptions: GIVE_UP_AT_ONCE });
            await assert.rejects(adapter.connect({ serviceName: "order.v1@test-host" }));
        });
        assert.equal(announced.name, "order.v1@test-host");
    });

    it("announces an explicit connectionOptions.name instead of the service identifier", async () => {
        const announced = await announcedConnectOptions(async (url) => {
            const adapter = NatsAdapter({ servers: url, connectionOptions: { ...GIVE_UP_AT_ONCE, name: "explicit-name" } });
            await assert.rejects(adapter.connect({ serviceName: "order.v1@test-host" }));
        });
        assert.equal(announced.name, "explicit-name");
    });

    it("announces no connection name when there is neither an explicit name nor a service identifier", async () => {
        const announced = await announcedConnectOptions(async (url) => {
            const adapter = NatsAdapter({ servers: url, connectionOptions: GIVE_UP_AT_ONCE });
            await assert.rejects(adapter.connect());
        });
        assert.equal(announced.name, undefined);
    });

    it("reaches the server when `servers` is given as an array", async () => {
        const announced = await announcedConnectOptions(async (url) => {
            const adapter = NatsAdapter({ servers: [url], connectionOptions: GIVE_UP_AT_ONCE });
            await assert.rejects(adapter.connect({ serviceName: "array.v1@test-host" }));
        });
        assert.equal(announced.name, "array.v1@test-host");
    });
});
