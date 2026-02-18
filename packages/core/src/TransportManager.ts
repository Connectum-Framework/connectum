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
import type { AddressInfo } from "node:net";
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

        const port = config.port ?? env.get("PORT").default(5000).asPortNumber();
        const host = config.host ?? env.get("LISTEN").default("0.0.0.0").asString();

        // Read TLS certificates if configured
        const tlsCerts = tls ? readTLSCertificates(tls) : undefined;

        if (tlsCerts) {
            // Mode 1: TLS + ALPN — both HTTP/1.1 and HTTP/2
            this._isHttp2 = true;
            this._server = createSecureServer(
                {
                    key: tlsCerts.key,
                    cert: tlsCerts.cert,
                    allowHTTP1,
                    enableTrace: false,
                    handshakeTimeout,
                    ...http2Options,
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
                    allowHTTP1: false,
                    enableTrace: false,
                    ...http2Options,
                },
                handler,
            );
        }

        // Track HTTP/2 sessions for force close on timeout (HTTP/2 servers only)
        if (this._isHttp2) {
            (this._server as Http2Server | Http2SecureServer).on("session", (session: ServerHttp2Session) => {
                this._sessions.add(session);
                session.on("close", () => {
                    this._sessions.delete(session);
                });
            });
        }

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
     * Gracefully close the HTTP/2 server (sends GOAWAY, waits for in-flight requests)
     */
    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this._server?.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Forcefully destroy all tracked HTTP/2 sessions
     */
    destroyAllSessions(): void {
        for (const session of this._sessions) {
            session.destroy();
        }
        this._sessions.clear();
    }

    /**
     * Reset internal state (nullify server, address, clear sessions)
     */
    dispose(): void {
        this._server = null;
        this._address = null;
        this._sessions.clear();
    }
}
