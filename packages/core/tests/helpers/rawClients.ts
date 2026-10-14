/**
 * Raw TCP peers for shutdown tests.
 *
 * A misbehaving peer is a plain `node:net` socket with `allowHalfOpen`: it
 * ignores the server's FIN and never ends or destroys itself, which behaves the
 * same on every runtime and does not depend on any HTTP/2 client quirk.
 * The server side of each connection is captured from the `connection` event so
 * a test can observe the one thing that keeps a process alive: the server-side
 * socket staying open.
 */

import { once } from "node:events";
import net, { type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** HTTP/2 connection preface followed by an empty SETTINGS frame. */
export const HTTP2_PREFACE = Buffer.concat([Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"), Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])]);

const HTTP2_FRAME_GOAWAY = 0x7;
const HTTP2_FRAME_SETTINGS = 0x4;

/** A connection as the server sees it. */
export interface AcceptedSocket {
    socket: Socket;
    /** Resolves once the server has read the first bytes (HTTP/1.1 only: HTTP/2 reads natively). */
    dataRead: Promise<void>;
}

/**
 * Capture the server-side socket of every connection any `net.Server` accepts
 * while the recorder is active. `next()` resolves with the first captured
 * socket not yet handed out, so call it before the client connects. Call
 * `restore()` when done.
 */
export function recordServerSockets(): { next(): Promise<AcceptedSocket>; restore(): void } {
    const captured: AcceptedSocket[] = [];
    const waiting: Array<(accepted: AcceptedSocket) => void> = [];
    const original = net.Server.prototype.emit;
    const hadOwnEmit = Object.hasOwn(net.Server.prototype, "emit");
    // Patched by hand: `mock.method` does not exist under Bun.
    net.Server.prototype.emit = function (this: net.Server, event: string | symbol, ...args: unknown[]): boolean {
        const handled = original.call(this, event, ...args);
        if (event === "connection") {
            const socket = args[0] as Socket;
            // Attached after the server's own listeners, so by the time it
            // fires the HTTP/1.1 parser has already consumed the bytes.
            // Bun's node:http never surfaces reads on the socket, but it does not
            // close idle connections early either, so there is nothing to wait for.
            const dataRead = "bun" in process.versions ? Promise.resolve() : once(socket, "data").then(() => undefined);
            const accepted: AcceptedSocket = { socket, dataRead };
            accepted.dataRead.catch(() => {});
            const waiter = waiting.shift();
            if (waiter) waiter(accepted);
            else captured.push(accepted);
        }
        return handled;
    };
    return {
        next: () => {
            const accepted = captured.shift();
            return accepted ? Promise.resolve(accepted) : new Promise<AcceptedSocket>((resolve) => waiting.push(resolve));
        },
        restore: () => {
            if (hadOwnEmit) net.Server.prototype.emit = original;
            else delete (net.Server.prototype as { emit?: unknown }).emit;
        },
    };
}

/**
 * Open a raw client that writes `payload` and then never closes. Resolves once
 * the connection is established and the payload is flushed to the kernel.
 */
export async function stubbornClient(options: { port: number; payload: Buffer | string; onHttp2Frame?: (type: number) => void }): Promise<Socket> {
    const socket = net.connect({ port: options.port, host: "127.0.0.1", allowHalfOpen: true });
    socket.on("error", () => {});
    // Attached before any byte can arrive, so no frame is missed.
    if (options.onHttp2Frame) watchHttp2Frames(socket, options.onHttp2Frame);
    socket.resume();
    await once(socket, "connect");
    if (options.payload.length > 0) {
        await new Promise<void>((resolve, reject) => socket.write(options.payload, (err) => (err ? reject(err) : resolve())));
    }
    return socket;
}

/** Parse HTTP/2 frames from a raw readable and report each frame type seen. */
export function watchHttp2Frames(stream: NodeJS.ReadableStream, onFrame: (type: number) => void): void {
    let buf = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 9) {
            const length = buf.readUIntBE(0, 3);
            if (buf.length < 9 + length) break;
            onFrame(buf[3] as number);
            buf = buf.subarray(9 + length);
        }
    });
}

export { HTTP2_FRAME_GOAWAY, HTTP2_FRAME_SETTINGS };

/** Resolve with `true` if `promise` settles within `ms`, `false` otherwise. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const ac = new AbortController();
    const result = await Promise.race([promise.then(() => true), delay(ms, false, { signal: ac.signal }).catch(() => false)]);
    ac.abort();
    return result;
}
