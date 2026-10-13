/**
 * Connection lifecycle events of the NATS adapter against a real NATS JetStream server.
 *
 * Set NATS_TEST_URL to a JetStream-enabled server, e.g.:
 *
 *   docker run -d --name nats -p 4222:4222 nats:2.10.29-alpine -js
 *   NATS_TEST_URL=nats://localhost:4222 pnpm exec exodus-test --typescript tests/integration/NatsLifecycle.integration.test.ts
 *
 * The oracle for the event order is the client's own documentation of `NatsConnection.status()`
 * (disconnect, then reconnecting dials, then reconnect; close when the reconnect budget is spent).
 * The network is cut and healed by a TCP proxy between the adapter and the server, which drops every
 * connection and stops accepting, so the order of events does not depend on timing.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { NatsAdapter } from "../../src/NatsAdapter.ts";
import type { NatsLifecycleEvent } from "../../src/types.ts";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor: ${label} not met within ${timeoutMs}ms`);
        }
        await sleep(25);
    }
}

interface CuttableProxy {
    readonly url: string;
    /** Drop every connection and refuse new ones: the server is unreachable. */
    cut(): Promise<void>;
    /** Accept connections again on the same port. */
    heal(): Promise<void>;
    close(): Promise<void>;
}

async function startProxy(target: { host: string; port: number }): Promise<CuttableProxy> {
    const sockets = new Set<net.Socket>();
    const make = (): net.Server =>
        net.createServer((client) => {
            const upstream = net.connect(target.port, target.host);
            sockets.add(client);
            sockets.add(upstream);
            client.pipe(upstream);
            upstream.pipe(client);
            const drop = (): void => {
                client.destroy();
                upstream.destroy();
                sockets.delete(client);
                sockets.delete(upstream);
            };
            client.on("close", drop);
            upstream.on("close", drop);
            client.on("error", () => undefined);
            upstream.on("error", () => undefined);
        });
    let server = make();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const closeServer = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
    return {
        url: `nats://127.0.0.1:${port}`,
        async cut() {
            const closed = closeServer();
            for (const socket of sockets) {
                socket.destroy();
            }
            await closed;
        },
        async heal() {
            server = make();
            await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
        },
        async close() {
            const closed = closeServer();
            for (const socket of sockets) {
                socket.destroy();
            }
            await closed;
        },
    };
}

function parseTarget(url: string): { host: string; port: number } {
    const parsed = new URL(url);
    return { host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname, port: Number(parsed.port || 4222) };
}

describe("NATS adapter lifecycle events", { skip: NATS_TEST_URL === undefined ? "NATS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const target = parseTarget(NATS_TEST_URL as string);
    const stream = `lifecycle-${Date.now().toString(36)}`;

    function collect(): { events: NatsLifecycleEvent[]; types: () => string[]; onLifecycle: (event: NatsLifecycleEvent) => void } {
        const events: NatsLifecycleEvent[] = [];
        return { events, types: () => events.map((e) => e.type), onLifecycle: (event) => events.push(event) };
    }

    it("reports the first connect once and nothing for an orderly disconnect", { timeout: 30_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = NatsAdapter({ servers: proxy.url, stream, lifecycle: { onLifecycle: seen.onLifecycle } });
        try {
            await adapter.connect();
            assert.deepEqual(seen.events, [{ type: "connected", reconnected: false }]);
            await adapter.disconnect();
            await sleep(500);
            assert.deepEqual(seen.types(), ["connected"], "our own close is not a loss");
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a drop and a recovery: one disconnected, reconnecting dials with growing attempt numbers, then connected with reconnected true", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = NatsAdapter({
            servers: proxy.url,
            stream,
            connectionOptions: { reconnectTimeWait: 100, maxReconnectAttempts: -1 },
            lifecycle: { onLifecycle: seen.onLifecycle },
        });
        try {
            await adapter.connect();
            await proxy.cut();
            await waitFor(() => seen.events.filter((e) => e.type === "reconnecting").length >= 2, "two redial attempts reported");
            await proxy.heal();
            await waitFor(() => seen.events.some((e) => e.type === "connected" && e.reconnected), "the recovery reported");

            const types = seen.types();
            assert.equal(types[0], "connected");
            assert.equal(types.filter((t) => t === "disconnected").length, 1, "one loss, one disconnected");
            assert.ok(types.indexOf("disconnected") < types.indexOf("reconnecting"));
            assert.equal(types.at(-1), "connected");
            const attempts = seen.events.filter((e): e is Extract<NatsLifecycleEvent, { type: "reconnecting" }> => e.type === "reconnecting").map((e) => e.attempt);
            assert.deepEqual(
                attempts,
                attempts.map((_, i) => i + 1),
                "attempts count up from 1",
            );
            assert.equal(types.includes("reconnect-failed"), false);

            await adapter.publish("lifecycle.after-recovery", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a reconnect budget that runs out ends in exactly one reconnect-failed, and the adapter can connect again", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = NatsAdapter({
            servers: proxy.url,
            stream,
            connectionOptions: { reconnectTimeWait: 100, maxReconnectAttempts: 2 },
            lifecycle: { onLifecycle: seen.onLifecycle },
        });
        try {
            await adapter.connect();
            await proxy.cut();
            await waitFor(() => seen.types().includes("reconnect-failed"), "the terminal event");
            await sleep(500);
            const types = seen.types();
            assert.equal(types.filter((t) => t === "reconnect-failed").length, 1);
            assert.equal(types.at(-1), "reconnect-failed", "nothing follows the terminal event");
            assert.ok(types.indexOf("disconnected") < types.indexOf("reconnect-failed"));
            const failed = seen.events.find((e) => e.type === "reconnect-failed");
            assert.ok(failed && failed.type === "reconnect-failed" && failed.error instanceof Error);

            // The dead connection is not kept: publishing says so, and connect() starts a fresh connection once the server is back.
            await assert.rejects(() => adapter.publish("lifecycle.after-failure", new Uint8Array([1])), /not connected/);
            await proxy.heal();
            await adapter.connect();
            await adapter.publish("lifecycle.after-failure", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a callback that throws or rejects does not stop publishing and is reported once as lifecycle-error", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const errors: NatsLifecycleEvent[] = [];
        const all: NatsLifecycleEvent[] = [];
        let calls = 0;
        const adapter = NatsAdapter({
            servers: proxy.url,
            stream,
            connectionOptions: { reconnectTimeWait: 100, maxReconnectAttempts: -1 },
            lifecycle: {
                onLifecycle: async (event) => {
                    calls += 1;
                    all.push(event);
                    if (event.type === "lifecycle-error") {
                        errors.push(event);
                        throw new Error("a failure while handling lifecycle-error is dropped");
                    }
                    if (calls % 2 === 0) {
                        throw new Error("synchronous failure");
                    }
                    throw new Error("rejected promise");
                },
            },
        });
        try {
            await adapter.connect();
            await waitFor(() => errors.length >= 1, "the first failure reported");
            await proxy.cut();
            await sleep(300);
            await proxy.heal();
            await waitFor(() => all.some((e) => e.type === "connected" && e.reconnected), "the recovery reported");
            await waitFor(() => errors.length >= 3, "failures of several callbacks reported");
            await adapter.publish("lifecycle.throwing", new Uint8Array([1]));
            assert.ok(errors.every((e) => e.type === "lifecycle-error" && e.callback === "onLifecycle"));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a callback that never returns does not delay disconnect()", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const adapter = NatsAdapter({ servers: proxy.url, stream, lifecycle: { onLifecycle: () => new Promise<void>(() => undefined) } });
        try {
            await adapter.connect();
            const startedAt = Date.now();
            await adapter.disconnect();
            assert.ok(Date.now() - startedAt < 10_000, "disconnect() finished without waiting for the callback");
        } finally {
            await proxy.close();
        }
    });

    it("without the option no status listener is attached: a drop reports nothing and the adapter behaves as before", { timeout: 30_000 }, async () => {
        const proxy = await startProxy(target);
        const adapter = NatsAdapter({ servers: proxy.url, stream, connectionOptions: { reconnectTimeWait: 100, maxReconnectAttempts: -1 } });
        try {
            await adapter.connect();
            await proxy.cut();
            await sleep(300);
            await proxy.heal();
            await sleep(1_000);
            await adapter.publish("lifecycle.no-option", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });
});
