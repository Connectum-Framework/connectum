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
import { createServer } from "../../../src/Server.ts";

type Request = { type: "start"; timeout: number; allowHTTP1: boolean; forceCloseOnTimeout?: boolean } | { type: "stop" };

let server: ReturnType<typeof createServer> | undefined;

const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (this: net.Server, event: string | symbol, ...args: unknown[]): boolean {
    const handled = emit.call(this, event, ...args);
    if (event === "connection") {
        // Attached after the server's own listeners: the HTTP/1.1 parser has read the bytes by then.
        (args[0] as net.Socket).once("data", () => process.send?.({ type: "data" }));
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
