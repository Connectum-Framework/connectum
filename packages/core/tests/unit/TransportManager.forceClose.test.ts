/**
 * TransportManager: shutdown against clients that never close their side.
 *
 * A peer that keeps its TCP connection open after the server has finished
 * with it (ignores GOAWAY, idles in keep-alive, never completes a request or
 * a TLS handshake) must not be able to keep the server — and therefore the
 * host process — alive after the shutdown timeout. Conversely, the graceful
 * phase must never cut such a connection early.
 *
 * The misbehaving peer is a raw `node:net` socket with `allowHalfOpen`: it
 * ignores the server's FIN and never ends or destroys itself, which is
 * deterministic on every runtime and does not depend on any particular
 * HTTP/2 client bug.
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as connectHttp2 } from "node:http2";
import type { Server as NetServer, Socket } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls } from "node:tls";
import type { TransportConfig } from "../../src/TransportManager.ts";
import { TransportManager } from "../../src/TransportManager.ts";

const noopHandler = () => {};
const respondOk = (_req: unknown, res: { end: (body: string) => void }) => res.end("ok");

const HTTP2_PREFACE = Buffer.concat([
    Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
    // empty SETTINGS frame: length 0, type 0x4, flags 0, stream 0
    Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]),
]);
const HTTP2_FRAME_GOAWAY = 0x7;

/** Resolve with `true` if `promise` settles within `ms`, `false` otherwise. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const ac = new AbortController();
    const result = await Promise.race([promise.then(() => true), delay(ms, false, { signal: ac.signal }).catch(() => false)]);
    ac.abort();
    return result;
}

/**
 * Open a raw client that writes `payload` and then never closes: it ignores
 * the server's FIN (allowHalfOpen) and never calls end()/destroy().
 */
async function stubbornClient(options: { port: number; payload: Buffer | string }): Promise<Socket> {
    const socket = connect({ port: options.port, host: "127.0.0.1", allowHalfOpen: true });
    socket.on("error", () => {});
    socket.resume();
    await once(socket, "connect");
    if (options.payload.length > 0) socket.write(options.payload);
    // give the server time to accept and parse what was sent
    await delay(50);
    return socket;
}

/** Resolve once an HTTP/2 GOAWAY frame arrives on a raw (already decrypted) stream. */
function goawayReceived(stream: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        stream.on("data", (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= 9) {
                const length = buf.readUIntBE(0, 3);
                if (buf.length < 9 + length) break;
                if (buf[3] === HTTP2_FRAME_GOAWAY) resolve();
                buf = buf.subarray(9 + length);
            }
        });
    });
}

describe("TransportManager shutdown with clients that never close", () => {
    let transport: TransportManager;
    let tlsDir: string;
    let tls: TransportConfig["tls"];
    let trustedCert: Buffer;
    const sockets: Socket[] = [];

    before(() => {
        // A throwaway self-signed pair generated per run, so no key material is
        // committed (the repository ignores *.key / *.crt). TLS here only
        // exercises the TLS transport's connection handling.
        tlsDir = mkdtempSync(join(tmpdir(), "connectum-force-close-"));
        const keyPath = join(tlsDir, "server.key");
        const certPath = join(tlsDir, "server.crt");
        execFileSync("openssl", [
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout",
            keyPath,
            "-out",
            certPath,
        ], { stdio: "ignore" });
        tls = { keyPath, certPath };
        // The client trusts exactly this certificate rather than disabling
        // verification, so the TLS path is exercised the way real clients use it.
        trustedCert = readFileSync(certPath);
    });

    after(() => {
        rmSync(tlsDir, { recursive: true, force: true });
    });

    afterEach(() => {
        for (const s of sockets.splice(0)) s.destroy();
        transport?.destroyAllSessions();
        transport?.dispose();
    });

    const cases: Array<{ name: string; config: () => TransportConfig; payload: Buffer | string }> = [
        {
            name: "plaintext HTTP/1.1 (default) with an unfinished request",
            config: () => ({}),
            payload: "GET / HTTP/1.1\r\nHost: loc",
        },
        {
            name: "plaintext h2c with an established session",
            config: () => ({ allowHTTP1: false }),
            payload: HTTP2_PREFACE,
        },
        {
            name: "TLS with a connection that never starts the handshake",
            config: () => ({ tls }),
            payload: "",
        },
    ];

    for (const { name, config, payload } of cases) {
        describe(name, () => {
            it("close() keeps the connection; destroyAllSessions() closes the server-side socket", async () => {
                transport = new TransportManager();
                await transport.listen(noopHandler, { ...config(), port: 0, host: "127.0.0.1" });
                // The oracle is the server-side socket: while it is open it
                // keeps the event loop — and the host process — alive. The
                // client never finishes its side, so client-side 'close' can
                // not be used, and the server.close() callback is not a
                // portable signal (Bun fires it without waiting for connections).
                const accepted = once(transport.server as unknown as NetServer, "connection") as Promise<[Socket]>;
                const port = transport.address?.port ?? 0;
                sockets.push(await stubbornClient({ port, payload }));
                const [serverSocket] = await accepted;
                const serverSocketClosed = once(serverSocket, "close");

                const closing = transport.close();
                closing.catch(() => {});

                // Graceful phase: the connection must survive — cutting it here
                // would abort in-flight requests before the shutdown timeout.
                assert.strictEqual(await settlesWithin(serverSocketClosed, 300), false, "graceful close must not drop the connection");

                // Force-close path (shutdown timeout with forceCloseOnTimeout).
                transport.destroyAllSessions();

                assert.strictEqual(await settlesWithin(serverSocketClosed, 2000), true, "force close must close the server-side socket");
                assert.strictEqual(await settlesWithin(closing, 2000), true, "server.close() must complete once connections are gone");
            });
        });
    }

    it("close() drains an idle HTTP/2 client without waiting for the force-close path", async () => {
        transport = new TransportManager();
        await transport.listen(respondOk as never, { allowHTTP1: false, port: 0, host: "127.0.0.1" });
        const session = connectHttp2(`http://127.0.0.1:${transport.address?.port}`);
        session.on("error", () => {});
        // A well-behaved client closes its session once the server says GOAWAY.
        session.on("goaway", () => session.close());
        const req = session.request({ ":path": "/" });
        req.resume();
        req.end();
        await once(req, "end");

        // Node >= 24 sends GOAWAY from server.close() itself, Node 22 does not:
        // without the explicit session.close() this would hang until the
        // force-close path on Node 22.
        assert.strictEqual(await settlesWithin(transport.close(), 2000), true, "idle HTTP/2 session must receive GOAWAY and drain");
        session.destroy();
    });

    it("a TLS session that completes its handshake after close() still receives GOAWAY", async () => {
        transport = new TransportManager();
        await transport.listen(noopHandler, { tls, port: 0, host: "127.0.0.1" });
        // TCP is accepted before close(), the TLS handshake (and so the HTTP/2
        // session) only completes after it: that session is created while the
        // server is already draining and must be told to go away too.
        const raw = connect({ port: transport.address?.port ?? 0, host: "127.0.0.1", allowHalfOpen: true });
        raw.on("error", () => {});
        sockets.push(raw);
        await once(raw, "connect");
        await delay(50);

        const closing = transport.close();
        closing.catch(() => {});

        const secure = connectTls({ socket: raw, ALPNProtocols: ["h2"], ca: trustedCert, servername: "localhost" });
        secure.on("error", () => {});
        const goaway = goawayReceived(secure);
        await once(secure, "secureConnect");
        secure.write(HTTP2_PREFACE);

        assert.strictEqual(await settlesWithin(goaway, 1000), true, "late session must receive GOAWAY during the graceful phase");
        secure.destroy();
    });
});
