import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";

/** A TCP server that accepts connections and never answers, like a firewall that swallows the handshake or a wedged proxy. */
async function startSilentServer(): Promise<{ readonly port: number; readonly accepted: () => number; close(): Promise<void> }> {
    const sockets = new Set<net.Socket>();
    let accepted = 0;
    const server = net.createServer((socket) => {
        accepted += 1;
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as net.AddressInfo).port,
        accepted: () => accepted,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

describe("RedisAdapter connect timeout", () => {
    it("rejects connect() after connectTimeout when the host accepts TCP and never answers", async () => {
        const silent = await startSilentServer();
        const adapter = RedisAdapter({ url: `redis://127.0.0.1:${silent.port}`, redisOptions: { connectTimeout: 300 } });
        try {
            const started = Date.now();
            const error = await adapter.connect().then(
                () => assert.fail("connect() must not resolve against a silent host"),
                (reason: Error) => reason,
            );
            const elapsed = Date.now() - started;

            assert.match(error.message, /RedisAdapter: connection not ready within 300 ms/);
            assert.ok(elapsed >= 250 && elapsed < 3000, `rejected after ${elapsed} ms`);
            assert.equal(silent.accepted(), 1, "the TCP connection was accepted, so the TCP timeout of the client never applied");
        } finally {
            await adapter.disconnect();
            await silent.close();
        }
    });

    it("leaves the adapter free to connect again after a timeout", async () => {
        const silent = await startSilentServer();
        const adapter = RedisAdapter({ url: `redis://127.0.0.1:${silent.port}`, redisOptions: { connectTimeout: 200 } });
        try {
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                const error = await adapter.connect().then(
                    () => assert.fail("connect() must not resolve against a silent host"),
                    (reason: Error) => reason,
                );
                assert.doesNotMatch(error.message, /already connected/);
                assert.match(error.message, /not ready within 200 ms/);
            }
            assert.equal(silent.accepted(), 2, "each attempt opened a fresh connection");
        } finally {
            await adapter.disconnect();
            await silent.close();
        }
    });
});
