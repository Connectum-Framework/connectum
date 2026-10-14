/**
 * `server.stop()` against a client that never closes its connection.
 *
 * Through the public `createServer()` API, with a real listening socket:
 * - with the default `forceCloseOnTimeout` the server-side connection is closed
 *   when `shutdown.timeout` elapses, not earlier and not much later, and
 *   `stop()` completes;
 * - with `forceCloseOnTimeout: false` `stop()` still completes at the timeout
 *   and runs the hooks, but the client's connection stays open and usable.
 *
 * The oracle is the server-side socket's `close` event: an open server-side
 * socket is exactly what keeps a host process alive. The client is a raw
 * `allowHalfOpen` socket that ignores the server's FIN.
 */

import assert from "node:assert";
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";
import type { Server } from "../../src/types.ts";
import { HTTP2_FRAME_GOAWAY, HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, recordServerSockets, settlesWithin, stubbornClient } from "../helpers/rawClients.ts";

/** Graceful phase length under test. */
const TIMEOUT_MS = 400;
/**
 * Upper bound beyond the timeout for the forced close and for `stop()` to
 * finish. The work after the timer fires is synchronous socket destruction
 * plus one event-loop turn; 2 s only absorbs a heavily loaded CI host.
 */
const SLACK_MS = 2000;
/** setTimeout may fire a millisecond or two early; this allows for it. */
const TIMER_JITTER_MS = 25;

const HTTP1_PARTIAL_REQUEST = "GET / HTTP/1.1\r\nHost: loc";

describe("server.stop() with a client that never closes its connection", () => {
    let recorder: ReturnType<typeof recordServerSockets>;
    const clients: Socket[] = [];
    const servers: Server[] = [];

    beforeEach(() => {
        recorder = recordServerSockets();
    });

    afterEach(async () => {
        recorder.restore();
        for (const client of clients.splice(0)) client.destroy();
        for (const server of servers.splice(0)) {
            if (server.isRunning) await server.stop();
        }
    });

    async function boot(options: { allowHTTP1: boolean; forceCloseOnTimeout?: boolean }): Promise<Server> {
        const server = createServer({
            services: [],
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: options.allowHTTP1,
            shutdown: { timeout: TIMEOUT_MS, ...(options.forceCloseOnTimeout === undefined ? {} : { forceCloseOnTimeout: options.forceCloseOnTimeout }) },
        });
        servers.push(server);
        await server.start();
        return server;
    }

    /**
     * Connect a stubborn client and return once the server has certainly
     * registered the connection as being in use: an HTTP/1.1 request that has
     * begun (a connection with no request in progress is idle and the server
     * may close it at once) or an HTTP/2 session that has sent its SETTINGS.
     */
    async function connectStubborn(server: Server, protocol: "http1" | "h2c"): Promise<{ client: Socket; serverSocket: Socket }> {
        const accepted = recorder.next();
        let settled: () => void = () => {};
        const serverSettings = new Promise<void>((resolve) => {
            settled = resolve;
        });
        const client = await stubbornClient({
            port: server.address?.port ?? 0,
            payload: protocol === "http1" ? HTTP1_PARTIAL_REQUEST : HTTP2_PREFACE,
            onHttp2Frame: (type) => {
                if (type === HTTP2_FRAME_SETTINGS) settled();
            },
        });
        clients.push(client);
        const { socket, dataRead } = await accepted;
        await (protocol === "http1" ? dataRead : serverSettings);
        return { client, serverSocket: socket };
    }

    // Bun's node:http server emits no 'connection' through the prototype hook the
    // server-side socket is captured with, so the HTTP/1.1 cases cannot observe
    // that socket there. The HTTP/2 cases cover Bun.
    const http1OnBun = "bun" in process.versions ? "the HTTP/1.1 server-side socket is not observable under Bun" : false;
    const cases = [
        { name: "plaintext HTTP/1.1 with an unfinished request", allowHTTP1: true, protocol: "http1", skip: http1OnBun },
        { name: "plaintext h2c with an established session", allowHTTP1: false, protocol: "h2c", skip: false },
    ] as const;

    for (const { name, allowHTTP1, protocol, skip } of cases) {
        describe(name, () => {
            it("closes the server-side socket at shutdown.timeout when forceCloseOnTimeout is not set", { skip }, async () => {
                const server = await boot({ allowHTTP1 });
                const { serverSocket } = await connectStubborn(server, protocol);
                const closedAt = once(serverSocket, "close").then(() => performance.now());

                const startedAt = performance.now();
                const stopped = server.stop();

                assert.strictEqual(await settlesWithin(closedAt, TIMEOUT_MS + SLACK_MS), true, "the server-side socket must be closed after the timeout");
                assert.strictEqual(await settlesWithin(stopped, SLACK_MS), true, "stop() must complete once the connection is gone");

                // The close time is the event's own timestamp, so the lower bound
                // proves the graceful phase did not cut the connection early.
                const elapsedAtClose = (await closedAt) - startedAt;
                assert.ok(elapsedAtClose >= TIMEOUT_MS - TIMER_JITTER_MS, `closed after ${elapsedAtClose} ms, before the ${TIMEOUT_MS} ms timeout`);
                assert.ok(elapsedAtClose < TIMEOUT_MS + SLACK_MS, `closed after ${elapsedAtClose} ms`);
            });
        });
    }

    it("tells an idle h2c session to go away at stop() and finishes long before shutdown.timeout", async () => {
        const server = createServer({ services: [], port: 0, host: "127.0.0.1", allowHTTP1: false, shutdown: { timeout: 30_000 } });
        servers.push(server);
        await server.start();
        let sawSettings: () => void = () => {};
        let sawGoaway: () => void = () => {};
        const settings = new Promise<void>((resolve) => {
            sawSettings = resolve;
        });
        const goaway = new Promise<void>((resolve) => {
            sawGoaway = resolve;
        });
        const client = await stubbornClient({
            port: server.address?.port ?? 0,
            payload: HTTP2_PREFACE,
            onHttp2Frame: (type) => {
                if (type === HTTP2_FRAME_SETTINGS) sawSettings();
                if (type === HTTP2_FRAME_GOAWAY) sawGoaway();
            },
        });
        clients.push(client);
        // A well-behaved client leaves as soon as it is told to.
        goaway.then(() => client.end());
        await settings;

        const stopped = server.stop();

        assert.strictEqual(await settlesWithin(goaway, SLACK_MS), true, "no GOAWAY frame reached the client");
        assert.strictEqual(await settlesWithin(stopped, SLACK_MS), true, "stop() must not wait for the 30 s timeout");
    });

    describe("forceCloseOnTimeout: false", () => {
        for (const { name, allowHTTP1, protocol, skip } of cases) {
            it(`${name}: resolves stop() at the timeout, runs the hook and keeps the connection open until the client closes it`, { skip }, async () => {
                const server = await boot({ allowHTTP1, forceCloseOnTimeout: false });
                const { client, serverSocket } = await connectStubborn(server, protocol);
                let serverSocketClosed = false;
                const closed = once(serverSocket, "close").then(() => {
                    serverSocketClosed = true;
                });
                let hookRan = false;
                server.onShutdown("probe", () => {
                    hookRan = true;
                });

                const startedAt = performance.now();
                await server.stop();
                const elapsed = performance.now() - startedAt;

                assert.ok(elapsed >= TIMEOUT_MS - TIMER_JITTER_MS, `stop() must wait for the graceful phase (took ${elapsed} ms)`);
                assert.ok(elapsed < TIMEOUT_MS + SLACK_MS, `stop() took ${elapsed} ms`);
                assert.strictEqual(hookRan, true, "shutdown hooks must run when the timeout wins");
                assert.strictEqual(serverSocketClosed, false, "the connection must not be terminated");
                assert.strictEqual(serverSocket.destroyed, false);

                if (protocol === "http1") {
                    // Positive proof the connection is alive, not merely not yet
                    // closed: finishing the request over it still gets a response.
                    const response = new Promise<string>((resolve) => {
                        client.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1")));
                    });
                    client.write("\r\nConnection: close\r\n\r\n");
                    assert.match(await response, /^HTTP\/1\.1 \d{3}/);
                }

                // The connection lives until the client lets go of it, and then goes (for
                // HTTP/1.1 the response above already asked to close, so it may be gone).
                client.end();
                assert.strictEqual(await settlesWithin(closed, SLACK_MS), true, "the server-side socket must close once the client closes its side");
            });
        }
    });
});
