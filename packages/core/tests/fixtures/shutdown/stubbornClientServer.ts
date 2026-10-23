/**
 * Child-process server for the process-exit test.
 *
 * It owns nothing but a `createServer()` instance and an IPC channel to its
 * parent, so once `stop()` has returned and the channel is closed, whatever
 * still keeps this process alive was left behind by the server itself. The
 * process is never ended explicitly: the test observes whether it exits on its
 * own.
 *
 * The parent must not ask for `stop()` before the server has read the client's
 * first bytes: a connection with no request under way is idle and is closed by
 * the graceful phase, which would hide the case under test. The child therefore
 * reports `data` once a connection has delivered its first bytes.
 */

import net from "node:net";
import tls from "node:tls";
import { createServer } from "../../../src/Server.ts";

type Request = { type: "start"; timeout: number; allowHTTP1: boolean; forceCloseOnTimeout?: boolean; tls?: { keyPath: string; certPath: string } } | { type: "stop" };

let server: ReturnType<typeof createServer> | undefined;

const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (this: net.Server, event: string | symbol, ...args: unknown[]): boolean {
    const handled = emit.call(this, event, ...args);
    if (event === "connection") {
        if (this instanceof tls.Server) {
            // A raw socket of a TLS server belongs to the TLS layer: a `data` listener here would take
            // bytes away from it. The accepted connection is reported without reading from it, which is
            // all a client stuck before its handshake can be waited for with.
            process.send?.({ type: "accepted" });
        } else {
            // Attached after the server's own listeners: the HTTP/1.1 parser has read the bytes by then.
            (args[0] as net.Socket).once("data", () => process.send?.({ type: "data" }));
        }
    } else if (event === "secureConnection" && this instanceof tls.Server) {
        // The decrypted socket of a completed handshake; the HTTP/1.1 parser of a TLS server reads from it.
        (args[0] as net.Socket).once("data", () => process.send?.({ type: "data" }));
    } else if (event === "session") {
        // An HTTP/2 session announces a request stream once its HEADERS frame has been read: the
        // connection then has a request under way, which the client's SETTINGS exchange does not show.
        (args[0] as import("node:http2").Http2Session).once("stream", () => process.send?.({ type: "stream" }));
    }
    return handled;
};

process.on("message", async (request: Request) => {
    if (request.type === "start") {
        server = createServer({
            services: [],
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: request.allowHTTP1,
            ...(request.tls ? { tls: request.tls } : {}),
            shutdown: { timeout: request.timeout, ...(request.forceCloseOnTimeout === undefined ? {} : { forceCloseOnTimeout: request.forceCloseOnTimeout }) },
        });
        await server.start();
        process.send?.({ type: "ready", port: server.address?.port });
    } else if (request.type === "stop") {
        await server?.stop();
        // Release the IPC channel: it is the one handle that is ours, not the server's.
        process.send?.({ type: "stopped" }, () => process.disconnect?.());
    }
});
