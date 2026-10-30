/**
 * `disconnect()` ends a `connect()` that waits on the network, whichever connection it is waiting on.
 *
 * The server below accepts the TCP connection and then says nothing: the handshake never completes,
 * which is what a broker behind a dropped firewall rule or an overloaded load balancer looks like.
 * amqplib sets no timeout unless `socketOptions.timeout` is given, so before the fix a `connect()`
 * waiting on such a socket in the startup probe, or on the single connection of `recovery: false`,
 * never settled and `disconnect()` had nothing to close.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { AmqpAdapter, type AmqpAdapterOptions, AmqpConnectionError } from "../../src/index.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fail with `label` instead of hanging when `promise` does not settle within `ms`. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms: ${label}`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function waitUntil(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) {
            throw new Error(`waitUntil: ${label}`);
        }
        await sleep(10);
    }
}

/** A TCP server that accepts connections and never answers. */
async function startBlackhole() {
    const sockets = new Set<net.Socket>();
    let accepted = 0;
    const server = net.createServer((socket) => {
        accepted += 1;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        // Read and discard what the client sends: a socket nobody reads never sees the client hang up, so it could not tell a closed connection from an open one.
        socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    return {
        port,
        accepted: () => accepted,
        open: () => sockets.size,
        async close(): Promise<void> {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

const modes: ReadonlyArray<{ readonly label: string; readonly extra: Partial<AmqpAdapterOptions> }> = [
    { label: "recovery: false (the single connection)", extra: { recovery: false } },
    { label: "recovery, no startup probe (the recovering connection)", extra: {} },
    { label: "recovery with lifecycle (startup probe)", extra: { lifecycle: { onLifecycle: () => undefined } } },
    { label: "recovery with failFastOnInitialSetupError (startup probe)", extra: { failFastOnInitialSetupError: true } },
    { label: "recovery with onSetupFailed (startup probe)", extra: { lifecycle: { onSetupFailed: () => undefined } } },
];

describe("disconnect() during a connect() that waits for a socket that never answers", () => {
    for (const mode of modes) {
        it(`ends the connect(), reports it as cancelled and leaves no socket open (${mode.label})`, { timeout: 30_000 }, async () => {
            const hole = await startBlackhole();
            const adapter = AmqpAdapter({ url: `amqp://guest:guest@127.0.0.1:${hole.port}`, exchange: "connect.cancel", ...mode.extra });
            try {
                const first = adapter.connect().then(
                    () => "resolved" as const,
                    (error: unknown) => error,
                );
                await waitUntil(() => hole.accepted() >= 1, "the adapter dialled the server");

                await within(adapter.disconnect(), 5_000, "disconnect()");
                const outcome = await within(first, 5_000, "the pending connect()");

                assert.ok(outcome instanceof AmqpConnectionError, `expected AmqpConnectionError, got ${String(outcome)}`);
                assert.match(outcome.message, /Adapter closed/);
                await waitUntil(() => hole.open() === 0, "every socket the adapter opened is closed");
            } finally {
                await adapter.disconnect().catch(() => undefined);
                await hole.close();
            }
        });
    }

    it("an AbortSignal the application passes in socketOptions still ends the socket of recovery: false", { timeout: 30_000 }, async () => {
        const hole = await startBlackhole();
        const own = new AbortController();
        const adapter = AmqpAdapter({ url: `amqp://guest:guest@127.0.0.1:${hole.port}`, exchange: "connect.cancel", recovery: false, socketOptions: { signal: own.signal } });
        try {
            const first = adapter.connect().then(
                () => "resolved" as const,
                (error: unknown) => error,
            );
            await waitUntil(() => hole.accepted() >= 1, "the adapter dialled the server");
            own.abort();
            await waitUntil(() => hole.open() === 0, "the application's signal destroyed the socket");
            const outcome = await within(first, 5_000, "the pending connect()");
            assert.ok(outcome instanceof Error, "the connect() rejects with the abort");
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await hole.close();
        }
    });

    it("a connect() after the cancelled one starts a clean attempt",{ timeout: 30_000 }, async () => {
        const hole = await startBlackhole();
        const adapter = AmqpAdapter({ url: `amqp://guest:guest@127.0.0.1:${hole.port}`, exchange: "connect.cancel", lifecycle: { onLifecycle: () => undefined } });
        try {
            const first = adapter.connect().then(
                () => "resolved" as const,
                (error: unknown) => error,
            );
            await waitUntil(() => hole.accepted() >= 1, "the adapter dialled the server");
            await within(adapter.disconnect(), 5_000, "disconnect()");
            await within(first, 5_000, "the pending connect()");

            const accepted = hole.accepted();
            const second = adapter.connect().then(
                () => "resolved" as const,
                (error: unknown) => error,
            );
            await waitUntil(() => hole.accepted() > accepted, "the second connect() dialled the server");
            await within(adapter.disconnect(), 5_000, "disconnect() of the second connect()");
            assert.ok((await within(second, 5_000, "the second pending connect()")) instanceof AmqpConnectionError);
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await hole.close();
        }
    });
});
