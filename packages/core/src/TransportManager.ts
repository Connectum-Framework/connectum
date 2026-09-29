/**
 * Transport Manager
 *
 * Manages the lifecycle of the HTTP server: create, listen, close, destroy sessions.
 * Supports 3 transport modes:
 * - TLS + ALPN: HTTP/1.1 and HTTP/2 via createSecureServer
 * - Plaintext HTTP/1.1: via http.createServer (default)
 * - Plaintext h2c: via http2.createServer
 *
 * @module TransportManager
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { Http2SecureServer, Http2Server, SecureServerOptions, ServerHttp2Session } from "node:http2";
import { createServer as createHttp2Server, createSecureServer } from "node:http2";
import type { AddressInfo, Socket } from "node:net";
import env from "env-var";
import { readTLSCertificates } from "./TLSConfig.ts";
import type { NodeRequest, NodeResponse, TLSOptions, TransportServer } from "./types.ts";

/**
 * Transport configuration for HTTP/2 server creation
 */
export interface TransportConfig {
    port?: number | undefined;
    host?: string | undefined;
    tls?: TLSOptions | undefined;
    allowHTTP1?: boolean | undefined;
    handshakeTimeout?: number | undefined;
    http2Options?: SecureServerOptions | undefined;
}

/**
 * Manages the server lifecycle: creation, listening, session tracking, and shutdown.
 *
 * Extracted from ServerImpl to encapsulate all transport-level concerns
 * (server creation, TLS, session tracking, close/destroy).
 */
export class TransportManager {
    private _server: TransportServer | null = null;
    private _address: AddressInfo | null = null;
    private _isHttp2 = false;
    private readonly _sessions: Set<ServerHttp2Session> = new Set();
    private readonly _sockets: Set<Socket> = new Set();
    /**
     * Closing state of the server started by the latest listen(). Each server
     * gets its own object and its session listener keeps a reference to it,
     * so starting a new server on this manager can never reopen an older one
     * that is still draining.
     */
    private _closingState: { closing: boolean } = { closing: false };

    /**
     * The underlying server instance
     */
    get server(): TransportServer | null {
        return this._server;
    }

    /**
     * The address the server is listening on
     */
    get address(): AddressInfo | null {
        return this._address;
    }

    /**
     * Create a server, attach session tracking (HTTP/2 only), and start listening.
     *
     * Transport modes:
     * - TLS + ALPN: HTTP/1.1 and HTTP/2 via createSecureServer
     * - Plaintext HTTP/1.1: via http.createServer (default without TLS)
     * - Plaintext h2c: via http2.createServer (when allowHTTP1=false without TLS)
     *
     * @param handler - Request handler (from connectNodeAdapter)
     * @param config - Transport configuration
     */
    async listen(handler: (req: NodeRequest, res: NodeResponse) => void, config: TransportConfig): Promise<void> {
        const { tls, allowHTTP1 = true, handshakeTimeout = 30_000, http2Options } = config;
        // A fresh server starts accepting; only close() marks it closing.
        const closingState = { closing: false };
        this._closingState = closingState;

        const port = config.port ?? env.get("PORT").default(5000).asPortNumber();
        const host = config.host ?? env.get("LISTEN").default("0.0.0.0").asString();

        // Read TLS certificates if configured
        const tlsCerts = tls ? readTLSCertificates(tls) : undefined;

        if (tlsCerts) {
            // Mode 1: TLS + ALPN — both HTTP/1.1 and HTTP/2
            this._isHttp2 = true;
            this._server = createSecureServer(
                {
                    enableTrace: false,
                    handshakeTimeout,
                    ...http2Options,
                    key: tlsCerts.key,
                    cert: tlsCerts.cert,
                    allowHTTP1,
                },
                handler,
            );
        } else if (allowHTTP1) {
            // Mode 2: Plaintext HTTP/1.1 (default without TLS)
            this._isHttp2 = false;
            this._server = createHttpServer(handler as (req: IncomingMessage, res: ServerResponse) => void);
        } else {
            // Mode 3: Plaintext h2c only
            this._isHttp2 = true;
            this._server = createHttp2Server(
                {
                    enableTrace: false,
                    ...http2Options,
                },
                handler,
            );
        }

        // Track HTTP/2 sessions: they get a graceful GOAWAY in close() and are
        // destroyed on the force-close path.
        if (this._isHttp2) {
            (this._server as Http2Server | Http2SecureServer).on("session", (session: ServerHttp2Session) => {
                this._sessions.add(session);
                session.on("close", () => {
                    this._sessions.delete(session);
                });
                // A connection accepted just before close() may complete its
                // HTTP/2 handshake afterwards; it must drain like the others.
                if (closingState.closing) session.close();
            });
        }

        // Track every accepted TCP connection, in all three modes. On the
        // force-close path destroying the HTTP/2 session is not enough: once
        // the session has sent GOAWAY and ended the socket, Node waits for the
        // peer's FIN, so a client that never closes its side keeps the socket,
        // the server and the process alive forever. HTTP/1.1 connections have
        // no session at all. For TLS this is the raw TCP socket, which also
        // covers connections stuck before the handshake completes.
        this._server.on("connection", (socket: Socket) => {
            this._sockets.add(socket);
            socket.once("close", () => {
                this._sockets.delete(socket);
            });
        });

        // Start listening
        await new Promise<void>((resolve, reject) => {
            if (!this._server) {
                reject(new Error("Server not created"));
                return;
            }

            const server = this._server;
            server.on("error", reject);

            try {
                server.listen(port, host, () => {
                    if (!this._server) {
                        server.removeListener("error", reject);
                        reject(new Error("Server closed during startup"));
                        return;
                    }

                    const address = this._server.address();
                    if (address && typeof address === "object") {
                        this._address = address;
                        const displayHost = address.address === "::" ? "localhost" : address.address;
                        console.info(`Server listening ${displayHost}:${address.port}`);
                    }

                    server.removeListener("error", reject);
                    resolve();
                });
            } catch (err) {
                server.removeListener("error", reject);
                reject(err);
            }
        });
    }

    /**
     * Gracefully close the server: stop accepting connections, send GOAWAY to
     * every HTTP/2 session and wait until all connections are gone.
     * In-flight streams are allowed to finish.
     */
    async close(): Promise<void> {
        this._closingState.closing = true;
        const closed = new Promise<void>((resolve, reject) => {
            this._server?.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        // Node >= 24 sends GOAWAY to open sessions from server.close() itself;
        // Node 22 does not, so an idle keep-alive HTTP/2 client would hold the
        // shutdown until the timeout. Calling session.close() again on a
        // session Node has already started closing is harmless.
        for (const session of this._sessions) {
            session.close();
        }
        await closed;
    }

    /**
     * Forcefully terminate every connection: destroy the tracked HTTP/2
     * sessions, then the underlying TCP sockets of all transports
     * (HTTP/2, HTTP/1.1, TLS). Used only on the shutdown-timeout path.
     */
    destroyAllSessions(): void {
        for (const session of this._sessions) {
            session.destroy();
        }
        this._sessions.clear();
        for (const socket of this._sockets) {
            socket.destroy();
        }
        this._sockets.clear();
    }

    /**
     * Reset internal state (nullify server, address, clear tracked sessions and sockets)
     *
     * The disposed server's closing state is deliberately left as it is (its
     * session listener holds it): with `forceCloseOnTimeout: false` the server
     * still completes TLS handshakes of connections taken before close(), and
     * a session completing after dispose() must still be told to go away
     * rather than serve requests after `stop()`.
     */
    dispose(): void {
        this._server = null;
        this._address = null;
        this._sessions.clear();
        this._sockets.clear();
    }
}
