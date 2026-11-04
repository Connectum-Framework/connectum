/**
 * A connect() that times out names the servers it tried.
 *
 * A host that accepts the connection and then stays silent makes the client fail with
 * `TimeoutError: timeout` and nothing else, so an operator with several servers configured cannot
 * tell which address, or which step, did not answer. The stand-in below answers with an INFO line and
 * then reads and discards everything, which is how a reachable-but-silent host looks to the client.
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";

async function withSilentServer<T>(run: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.write('INFO {"server_id":"stand-in","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576,"jetstream":true}\r\n');
        socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        return await run(`nats://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe("NatsAdapter connect timeout", () => {
    it("names the servers and keeps the client's TimeoutError", async () => {
        await withSilentServer(async (url) => {
            // In the given order, the silent server last: the client reports the error of the last server it dialled.
            const adapter = NatsAdapter({ servers: ["nats://127.0.0.1:1", url], connectionOptions: { timeout: 300, reconnect: false, noRandomize: true } });
            await assert.rejects(adapter.connect(), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.name, "TimeoutError", "the error keeps its class so callers that test for it keep working");
                assert.equal(error.message, `NatsAdapter: connect to nats://127.0.0.1:1, ${url} did not complete in time: timeout`);
                return true;
            });
        });
    });

    it("leaves the credentials of a server URL out of the message", async () => {
        await withSilentServer(async (url) => {
            const withUser = url.replace("nats://", "nats://svc:s3cret@");
            const withToken = url.replace("nats://", "nats://t0ken@");
            const adapter = NatsAdapter({ servers: [withUser, withToken], connectionOptions: { timeout: 300, reconnect: false } });
            await assert.rejects(adapter.connect(), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `NatsAdapter: connect to ${url}, ${url} did not complete in time: timeout`);
                assert.doesNotMatch(error.message, /s3cret|t0ken|svc/);
                return true;
            });
        });
    });

    it("names a single server", async () => {
        await withSilentServer(async (url) => {
            const adapter = NatsAdapter({ servers: url, connectionOptions: { timeout: 300, reconnect: false } });
            await assert.rejects(adapter.connect(), { message: `NatsAdapter: connect to ${url} did not complete in time: timeout` });
        });
    });
});
