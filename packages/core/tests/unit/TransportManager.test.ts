/**
 * TransportManager unit tests
 *
 * Tests for transport lifecycle: creation, listening,
 * session tracking, graceful close, and dispose.
 * Covers 3 transport modes: TLS+ALPN, plaintext HTTP/1.1, plaintext h2c.
 */

import assert from "node:assert";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { afterEach, describe, it } from "node:test";
import { TransportManager } from "../../src/TransportManager.ts";
import { HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, settlesWithin, watchHttp2Frames } from "../helpers/rawClients.ts";

/**
 * Minimal no-op handler for listen() calls
 */
const noopHandler = () => {};

/** Handler that answers every request with 200 and the body "ok". */
const okHandler: Parameters<TransportManager["listen"]>[0] = (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
};

const REQUEST_TIMEOUT_MS = 3000;

/** One plaintext HTTP/1.1 request on a fresh connection; rejects when no response arrives. */
function http1Request(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/", agent: false, timeout: REQUEST_TIMEOUT_MS }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("timeout", () => req.destroy(new Error("no HTTP/1.1 response")));
        req.on("error", reject);
        req.end();
    });
}

/** One plaintext HTTP/2 (prior knowledge) request on a fresh session; rejects when no response arrives. */
function http2Request(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const session = http2.connect(`http://127.0.0.1:${port}`);
        session.on("error", reject);
        session.on("close", () => reject(new Error("the HTTP/2 session closed before a response")));
        session.setTimeout(REQUEST_TIMEOUT_MS, () => session.destroy(new Error("no HTTP/2 response")));
        const req = session.request({ ":path": "/" });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
            status = Number(headers[":status"]);
        });
        req.on("data", (chunk: string) => {
            body += chunk;
        });
        req.on("end", () => {
            session.close();
            resolve({ status, body });
        });
        req.on("error", reject);
        req.end();
    });
}

/** Whether a TCP connection to the loopback port is accepted (false when it is refused). */
function acceptsConnections(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

// Bun's node:http2 client and plain-HTTP server differ from Node.js in how they reject a
// request of the wrong protocol, so the cross-protocol refusal checks run on Node.js only.
const onBun = "bun" in process.versions ? "the cross-protocol refusal is Node.js behaviour" : false;

describe("TransportManager", () => {
    let transport: TransportManager;

    afterEach(async () => {
        // Ensure transport is cleaned up after each test
        try {
            if (transport?.server) {
                await transport.close();
            }
        } catch {
            // Ignore errors during cleanup
        }
        transport?.dispose();
    });

    // -----------------------------------------------------------------
    // listen()
    // -----------------------------------------------------------------

    describe("listen()", () => {
        // The wire is the oracle (Node.js http2 documentation: `http2.createServer()` serves
        // plaintext HTTP/2 only, while `http.createServer()` serves HTTP/1.x): the transport
        // mode is told by which protocol is actually spoken, not by listeners on the server.
        it("should speak plaintext HTTP/1.1 and not HTTP/2 when allowHTTP1=true", { skip: onBun }, async () => {
            transport = new TransportManager();
            await transport.listen(okHandler, { port: 0, host: "127.0.0.1" });
            const port = transport.address?.port ?? 0;

            assert.deepStrictEqual(await http1Request(port), { status: 200, body: "ok" });
            await assert.rejects(() => http2Request(port), "an HTTP/2 client must not get a response from the HTTP/1.1 listener");
        });

        it("should speak plaintext HTTP/2 (h2c) and not HTTP/1.1 when allowHTTP1=false", { skip: onBun }, async () => {
            transport = new TransportManager();
            await transport.listen(okHandler, { port: 0, host: "127.0.0.1", allowHTTP1: false });
            const port = transport.address?.port ?? 0;

            assert.deepStrictEqual(await http2Request(port), { status: 200, body: "ok" });
            await assert.rejects(() => http1Request(port), "an HTTP/1.1 client must not get a response from the h2c listener");
        });

        it("should resolve address with correct host", async () => {
            transport = new TransportManager();

            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });

            assert.strictEqual(transport.address?.address, "127.0.0.1");
        });

        /** Run `fn` with PORT and LISTEN set to the given values (unset when undefined), restoring the originals afterwards. */
        async function withListenEnv(values: { PORT?: string; LISTEN?: string }, fn: () => Promise<void>): Promise<void> {
            const saved = { PORT: process.env.PORT, LISTEN: process.env.LISTEN };
            for (const name of ["PORT", "LISTEN"] as const) {
                const value = values[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            try {
                await fn();
            } finally {
                for (const name of ["PORT", "LISTEN"] as const) {
                    const value = saved[name];
                    if (value === undefined) delete process.env[name];
                    else process.env[name] = value;
                }
            }
        }

        /** A port that is free right now: bind port 0, read the number, release it. */
        async function freePort(): Promise<number> {
            const probe = net.createServer();
            await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
            const { port } = probe.address() as net.AddressInfo;
            await new Promise<void>((resolve) => probe.close(() => resolve()));
            return port;
        }

        // Configuration guide: `PORT` and `LISTEN` are read directly when the matching server option is omitted.
        it("should read PORT and LISTEN from the environment when the options are omitted", async () => {
            const port = await freePort();
            await withListenEnv({ PORT: String(port), LISTEN: "127.0.0.1" }, async () => {
                transport = new TransportManager();

                await transport.listen(noopHandler, {});

                assert.strictEqual(transport.address?.port, port);
                assert.strictEqual(transport.address?.address, "127.0.0.1");
            });
        });

        it("should prefer the port and host options over PORT and LISTEN", async () => {
            const envPort = await freePort();
            // 203.0.113.1 (TEST-NET-3) is not an address of this machine, so binding it would fail.
            await withListenEnv({ PORT: String(envPort), LISTEN: "203.0.113.1" }, async () => {
                transport = new TransportManager();

                await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });

                assert.strictEqual(transport.address?.address, "127.0.0.1");
                assert.notStrictEqual(transport.address?.port, envPort);
            });
        });

        // Configuration guide, server variables: `PORT` defaults to 5000 and `LISTEN` to "0.0.0.0".
        it("should listen on 0.0.0.0:5000 when neither the options nor the environment say otherwise", async (t) => {
            await withListenEnv({}, async () => {
                transport = new TransportManager();

                try {
                    await transport.listen(noopHandler, {});
                } catch (err) {
                    if ((err as { code?: string }).code === "EADDRINUSE") {
                        t.skip("port 5000 is taken on this machine, so the default cannot be observed");
                        return;
                    }
                    throw err;
                }

                assert.strictEqual(transport.address?.port, 5000);
                assert.strictEqual(transport.address?.address, "0.0.0.0");
            });
        });

        it("should handle port-in-use error", async () => {
            // Occupy a port with first transport
            const transport1 = new TransportManager();
            await transport1.listen(noopHandler, { port: 0, host: "127.0.0.1" });

            const occupiedPort = transport1.address?.port;
            assert.ok(occupiedPort);

            // Try to bind the same port
            transport = new TransportManager();

            await assert.rejects(
                () => transport.listen(noopHandler, { port: occupiedPort, host: "127.0.0.1" }),
                { code: "EADDRINUSE" },
            );

            // Cleanup first transport
            await transport1.close();
            transport1.dispose();
        });
    });

    // -----------------------------------------------------------------
    // close()
    // -----------------------------------------------------------------

    describe("close()", () => {
        // Node.js `server.close()`: "stops the server from accepting new connections".
        it("should release the port so that new connections are refused", async () => {
            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });
            const port = transport.address?.port ?? 0;
            assert.strictEqual(await acceptsConnections(port), true, "the listener must accept connections before close()");

            await transport.close();

            assert.strictEqual(transport.server?.listening, false);
            assert.strictEqual(await acceptsConnections(port), false, "the port must be released after close()");
        });

        // Node.js `server.close()`: the callback fires only once every connection has ended,
        // so a request that is still being handled is allowed to finish.
        it("should let an in-flight request finish and resolve only after it did", async () => {
            transport = new TransportManager();
            let release: () => void = () => {};
            let handling: () => void = () => {};
            const handlerReached = new Promise<void>((resolve) => {
                handling = resolve;
            });
            await transport.listen(
                (_req, res) => {
                    handling();
                    release = () => {
                        res.statusCode = 200;
                        res.end("late");
                    };
                },
                { port: 0, host: "127.0.0.1" },
            );
            const response = http1Request(transport.address?.port ?? 0);
            await handlerReached;

            let closed = false;
            const closing = transport.close().then(() => {
                closed = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const closedWhileInFlight = closed;
            release();

            assert.deepStrictEqual(await response, { status: 200, body: "late" });
            await closing;
            assert.strictEqual(closedWhileInFlight, false, "close() resolved while a request was still being handled");
        });

    });

    // -----------------------------------------------------------------
    // destroyAllSessions()
    // -----------------------------------------------------------------

    describe("destroyAllSessions()", () => {
        it("should terminate a live connection, and a repeated call is harmless", async () => {
            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1", allowHTTP1: false });
            // An established HTTP/2 session, kept open by a client that never leaves. The
            // client socket is not half-open, so it closes as soon as the server ends the connection.
            const client = net.connect({ port: transport.address?.port ?? 0, host: "127.0.0.1" });
            client.on("error", () => {});
            const serverSettings = new Promise<void>((resolve) => {
                watchHttp2Frames(client, (type) => {
                    if (type === HTTP2_FRAME_SETTINGS) resolve();
                });
            });
            client.write(HTTP2_PREFACE);
            await serverSettings;
            const closedByServer = new Promise<void>((resolve) => client.once("close", () => resolve()));

            transport.destroyAllSessions();

            assert.strictEqual(await settlesWithin(closedByServer, 2000), true, "the live connection must be terminated");
            assert.doesNotThrow(() => transport.destroyAllSessions());
        });
    });

    // -----------------------------------------------------------------
    // dispose()
    // -----------------------------------------------------------------

    describe("dispose()", () => {
        it("should set server to null", async () => {
            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });
            await transport.close();

            transport.dispose();

            assert.strictEqual(transport.server, null);
        });

        it("should set address to null", async () => {
            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });
            await transport.close();

            transport.dispose();

            assert.strictEqual(transport.address, null);
        });

        it("should be idempotent: a second dispose() after a real listen/close/dispose cycle does not throw and leaves the state empty", async () => {
            // A repeated dispose() is what a stop() that failed halfway and is
            // retried does; it must not dereference the already-dropped server.
            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });
            await transport.close();
            transport.dispose();

            assert.doesNotThrow(() => {
                transport.dispose();
            });

            assert.strictEqual(transport.server, null);
            assert.strictEqual(transport.address, null);
        });
    });

    // -----------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------

    describe("address getter", () => {
        it("should report the address the listener is bound to, and nothing before listen", async () => {
            transport = new TransportManager();
            assert.strictEqual(transport.address, null);
            assert.strictEqual(transport.server, null);

            transport = new TransportManager();
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });

            assert.ok(transport.server?.listening, "the server is exposed and listening");
            const addr = transport.address;
            assert.ok(addr);
            assert.strictEqual(addr.address, "127.0.0.1");
            assert.strictEqual(addr.family, "IPv4");
            // The reported port is the one the listener is really bound to.
            assert.ok(addr.port > 0 && addr.port <= 65535);
            assert.strictEqual(await acceptsConnections(addr.port), true);
        });
    });

    // -----------------------------------------------------------------
    // HTTP/1.1 response
    // -----------------------------------------------------------------

    describe("HTTP/1.1 transport", () => {
        it("should respond to HTTP/1.1 requests on default plaintext", async () => {
            const http = await import("node:http");
            transport = new TransportManager();

            const handler: Parameters<TransportManager["listen"]>[0] = (_req, res) => {
                res.statusCode = 200;
                res.setHeader("content-type", "text/plain");
                res.end("ok");
            };

            await transport.listen(handler, { port: 0, host: "127.0.0.1" });
            assert.ok(transport.address, "address should be set");
            const port = transport.address!.port;

            const body = await new Promise<string>((resolve, reject) => {
                const req = http.request(`http://127.0.0.1:${port}`, (res) => {
                    let data = "";
                    res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
                    res.on("end", () => resolve(data));
                });
                req.on("error", reject);
                req.end();
            });

            assert.strictEqual(body, "ok");
        });
    });

    // -----------------------------------------------------------------
    // Full lifecycle
    // -----------------------------------------------------------------

    describe("full lifecycle", () => {
        it("should support listen -> close -> dispose cycle", async () => {
            transport = new TransportManager();

            // Before listen
            assert.strictEqual(transport.server, null);
            assert.strictEqual(transport.address, null);

            // After listen
            await transport.listen(noopHandler, { port: 0, host: "127.0.0.1" });
            assert.ok(transport.server);
            assert.ok(transport.address);

            // After close
            await transport.close();
            assert.ok(transport.server, "server still exists after close");
            assert.ok(transport.address, "address still exists after close");

            // After dispose
            transport.dispose();
            assert.strictEqual(transport.server, null);
            assert.strictEqual(transport.address, null);
        });
    });
});
