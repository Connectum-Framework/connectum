/**
 * TransportManager.close(): every open HTTP/2 session is told to go away.
 *
 * Newer Node.js versions send GOAWAY to open sessions from `server.close()`
 * itself; Node 22 does not, and there an idle keep-alive client would hold the
 * shutdown until the timeout. The transport therefore has to ask each session
 * to close on its own. To keep that duty tested on every runtime, the server's
 * `close()` is replaced with the bare `net.Server` one, which only stops
 * listening and never touches sessions — the behaviour of the older Node.
 *
 * The oracle is the wire: the client is a raw TCP socket that parses HTTP/2
 * frames, so a GOAWAY is observed as the frame itself, not as a client-library
 * event.
 */

import assert from "node:assert";
import net, { type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, it } from "node:test";
import { TransportManager } from "../../src/TransportManager.ts";
import { HTTP2_FRAME_GOAWAY, HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, settlesWithin, stubbornClient } from "../helpers/rawClients.ts";

const noopHandler = () => {};
/** Bound for GOAWAY to arrive and the drain to finish; local, unloaded work takes milliseconds. */
const DRAIN_BOUND_MS = 2000;

describe("TransportManager.close() sends GOAWAY to idle HTTP/2 sessions", () => {
    let transport: TransportManager | undefined;
    const clients: Socket[] = [];

    afterEach(async () => {
        for (const client of clients.splice(0)) client.destroy();
        transport?.destroyAllSessions();
        const server = transport?.server as unknown as NetServer | null | undefined;
        transport?.dispose();
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        transport = undefined;
    });

    /** Start an h2c transport and connect a raw client that has an established, idle session. */
    async function withIdleSession(options: { stubServerClose: boolean }): Promise<{ goaways: () => number; goawayReceived: Promise<void>; client: Socket }> {
        transport = new TransportManager();
        await transport.listen(noopHandler, { allowHTTP1: false, port: 0, host: "127.0.0.1" });
        const server = transport.server as unknown as NetServer;
        if (options.stubServerClose) {
            // The older-Node behaviour: stop listening, never signal sessions.
            server.close = ((callback?: (err?: Error) => void) => net.Server.prototype.close.call(server, callback)) as typeof server.close;
        }

        let goawayCount = 0;
        let sawSettings: () => void = () => {};
        let sawGoaway: () => void = () => {};
        const settings = new Promise<void>((resolve) => {
            sawSettings = resolve;
        });
        const goawayReceived = new Promise<void>((resolve) => {
            sawGoaway = resolve;
        });
        const client = await stubbornClient({
            port: transport.address?.port ?? 0,
            payload: HTTP2_PREFACE,
            onHttp2Frame: (type) => {
                if (type === HTTP2_FRAME_SETTINGS) sawSettings();
                if (type === HTTP2_FRAME_GOAWAY) {
                    goawayCount += 1;
                    sawGoaway();
                }
            },
        });
        clients.push(client);
        // A well-behaved client: it ends its side once told to go away.
        goawayReceived.then(() => client.end());
        // The server's SETTINGS frame proves the session exists before close().
        await settings;
        return { goaways: () => goawayCount, goawayReceived, client };
    }

    it("the client receives a GOAWAY frame and the drain completes without the force-close path", async () => {
        const { goaways, goawayReceived } = await withIdleSession({ stubServerClose: true });

        const closing = (transport as TransportManager).close();

        assert.strictEqual(await settlesWithin(goawayReceived, DRAIN_BOUND_MS), true, "no GOAWAY frame reached the client");
        assert.ok(goaways() >= 1);
        assert.strictEqual(await settlesWithin(closing, DRAIN_BOUND_MS), true, "close() must finish once the client has left");
    });

    it("the real server.close() path also delivers GOAWAY and drains", async () => {
        const { goawayReceived } = await withIdleSession({ stubServerClose: false });

        const closing = (transport as TransportManager).close();

        assert.strictEqual(await settlesWithin(goawayReceived, DRAIN_BOUND_MS), true, "no GOAWAY frame reached the client");
        assert.strictEqual(await settlesWithin(closing, DRAIN_BOUND_MS), true, "close() must finish once the client has left");
    });
});
