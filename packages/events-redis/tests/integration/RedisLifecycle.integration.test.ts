/**
 * Connection lifecycle events of the Redis adapter against a real Redis or Valkey server.
 *
 * Set REDIS_TEST_URL, e.g.:
 *
 *   docker run -d --name redis -p 6379:6379 redis:6.2-alpine
 *   REDIS_TEST_URL=redis://localhost:6379 pnpm exec exodus-test --typescript tests/integration/RedisLifecycle.integration.test.ts
 *
 * The oracle for the event order is the "Connection Events" table of the ioredis documentation
 * (connect, ready, error, close, reconnecting, end). The network is cut and healed by a TCP proxy
 * between the adapter and the server, which drops every connection and stops accepting, so the
 * order of events does not depend on timing.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { RedisAdapter } from "../../src/RedisAdapter.ts";
import type { RedisLifecycleConnection, RedisLifecycleEvent } from "../../src/types.ts";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

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
    readonly port: number;
    cut(): Promise<void>;
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
    const destroyAll = async (): Promise<void> => {
        const closed = closeServer();
        for (const socket of sockets) {
            socket.destroy();
        }
        await closed;
    };
    return {
        port,
        cut: destroyAll,
        async heal() {
            server = make();
            await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
        },
        close: destroyAll,
    };
}

function parseTarget(url: string): { host: string; port: number } {
    const parsed = new URL(url);
    return { host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname, port: Number(parsed.port || 6379) };
}

const isReader = (c: RedisLifecycleConnection): c is Exclude<RedisLifecycleConnection, "publisher"> => typeof c === "object";

describe("Redis adapter lifecycle events", { skip: REDIS_TEST_URL === undefined ? "REDIS_TEST_URL not set" : false, concurrency: 1 }, () => {
    const target = parseTarget(REDIS_TEST_URL as string);
    const unique = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

    function collect(): { events: RedisLifecycleEvent[]; of: (type: string) => RedisLifecycleEvent[]; onLifecycle: (event: RedisLifecycleEvent) => void } {
        const events: RedisLifecycleEvent[] = [];
        return { events, of: (type) => events.filter((e) => e.type === type), onLifecycle: (event) => events.push(event) };
    }

    it("reports each connection's first ready once and nothing for an orderly disconnect or unsubscribe", { timeout: 30_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = RedisAdapter({ redisOptions: { host: "127.0.0.1", port: proxy.port }, lifecycle: { onLifecycle: seen.onLifecycle } });
        try {
            await adapter.connect();
            assert.deepEqual(seen.events, [{ type: "connected", reconnected: false, connection: "publisher" }]);

            const topic = unique("lc.first");
            const subscription = await adapter.subscribe([topic], async (_event, ack) => ack(), { group: unique("g") });
            assert.equal(seen.of("connected").length, 2, "the subscription's own connection reports its first ready");
            const reader = seen.of("connected")[1] as Extract<RedisLifecycleEvent, { type: "connected" }>;
            assert.ok(isReader(reader.connection) && reader.connection.patterns[0] === topic);
            assert.equal(reader.reconnected, false);

            await subscription.unsubscribe();
            await adapter.disconnect();
            await sleep(500);
            assert.deepEqual(
                seen.events.map((e) => e.type),
                ["connected", "connected"],
                "our own closes are not losses",
            );
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a drop and a recovery: exactly one disconnected and one connected per connection, with reconnecting attempts counted from 1", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = RedisAdapter({ redisOptions: { host: "127.0.0.1", port: proxy.port }, lifecycle: { onLifecycle: seen.onLifecycle } });
        try {
            await adapter.connect();
            await adapter.subscribe([unique("lc.drop")], async (_event, ack) => ack(), { group: unique("g") });
            await proxy.cut();
            await waitFor(() => seen.of("reconnecting").length >= 4, "redial attempts reported for both connections");
            await proxy.heal();
            await waitFor(() => seen.events.filter((e) => e.type === "connected" && e.reconnected).length === 2, "both connections recovered");
            await sleep(300);

            assert.equal(seen.of("disconnected").length, 2, "one loss per connection, however many attempts failed");
            const connections = seen.of("disconnected").map((e) => (e as Extract<RedisLifecycleEvent, { type: "disconnected" }>).connection);
            assert.equal(connections.filter(isReader).length, 1);
            assert.ok(connections.includes("publisher"));
            for (const connection of ["publisher", "reader"] as const) {
                const mine = seen.events.filter((e) => "connection" in e && (connection === "publisher" ? e.connection === "publisher" : isReader(e.connection)));
                const order = mine.map((e) => e.type);
                assert.equal(order[0], "connected");
                assert.equal(order[1], "disconnected");
                assert.equal(order.at(-1), "connected", `${connection} ends recovered`);
                const attempts = mine.filter((e) => e.type === "reconnecting").map((e) => (e as Extract<RedisLifecycleEvent, { type: "reconnecting" }>).attempt);
                assert.deepEqual(
                    attempts,
                    attempts.map((_, i) => i + 1),
                    `${connection} attempts count up from 1`,
                );
            }
            assert.equal(seen.of("reconnect-failed").length, 0);

            await adapter.publish("lc.after", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a retry strategy that gives up ends in exactly one reconnect-failed, after the disconnected", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const seen = collect();
        const adapter = RedisAdapter({
            redisOptions: { host: "127.0.0.1", port: proxy.port, retryStrategy: (times) => (times <= 2 ? 50 : null) },
            lifecycle: { onLifecycle: seen.onLifecycle },
        });
        try {
            await adapter.connect();
            await proxy.cut();
            await waitFor(() => seen.of("reconnect-failed").length >= 1, "the terminal event");
            await sleep(500);
            assert.equal(seen.of("reconnect-failed").length, 1);
            assert.equal(seen.events.at(-1)?.type, "reconnect-failed", "nothing follows the terminal event");
            assert.equal(seen.of("disconnected").length, 1);
            const failed = seen.of("reconnect-failed")[0] as Extract<RedisLifecycleEvent, { type: "reconnect-failed" }>;
            assert.equal(failed.connection, "publisher");
            assert.ok(failed.error instanceof Error);
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("a callback that throws or rejects is reported as lifecycle-error and does not stop publishing", { timeout: 60_000 }, async () => {
        const proxy = await startProxy(target);
        const failures: RedisLifecycleEvent[] = [];
        const all: RedisLifecycleEvent[] = [];
        let calls = 0;
        const adapter = RedisAdapter({
            redisOptions: { host: "127.0.0.1", port: proxy.port },
            lifecycle: {
                onLifecycle: async (event) => {
                    calls += 1;
                    all.push(event);
                    if (event.type === "lifecycle-error") {
                        failures.push(event);
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
            await waitFor(() => failures.length >= 1, "the first failure reported");
            await proxy.cut();
            await sleep(300);
            await proxy.heal();
            await waitFor(() => all.some((e) => e.type === "connected" && e.reconnected), "the recovery reported");
            await waitFor(() => failures.length >= 3, "failures of several callbacks reported");
            await adapter.publish("lc.throwing", new Uint8Array([1]));
            assert.ok(failures.every((e) => e.type === "lifecycle-error" && e.callback === "onLifecycle"));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });

    it("without the option the adapter behaves as before across a drop", { timeout: 30_000 }, async () => {
        const proxy = await startProxy(target);
        const adapter = RedisAdapter({ redisOptions: { host: "127.0.0.1", port: proxy.port } });
        try {
            await adapter.connect();
            await proxy.cut();
            await sleep(300);
            await proxy.heal();
            await sleep(1_500);
            await adapter.publish("lc.no-option", new Uint8Array([1]));
        } finally {
            await adapter.disconnect().catch(() => undefined);
            await proxy.close();
        }
    });
});
