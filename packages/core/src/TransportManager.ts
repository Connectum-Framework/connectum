/**
 * HTTP/2 Transport Manager
 *
 * Manages the lifecycle of the HTTP/2 server: create, listen, close, destroy sessions.
 *
 * @module TransportManager
 */

import { createServer as createHttp2Server, createSecureServer } from "node:http2";
import type { Http2SecureServer, Http2Server, Http2ServerRequest, Http2ServerResponse, SecureServerOptions, ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import env from "env-var";
import { readTLSCertificates } from "./TLSConfig.ts";
import type { TLSOptions } from "./types.ts";

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
 * Manages the HTTP/2 server lifecycle: creation, listening, session tracking, and shutdown.
 *
 * Extracted from ServerImpl to encapsulate all transport-level concerns
 * (HTTP/2 server creation, TLS, session tracking, close/destroy).
 */
export class TransportManager {
    private _server: Http2SecureServer | Http2Server | null = null;
    private _address: AddressInfo | null = null;
    private readonly _sessions: Set<ServerHttp2Session> = new Set();

    /**
     * The underlying HTTP/2 server instance
     */
    get server(): Http2SecureServer | Http2Server | null {
        return this._server;
    }

    /**
     * The address the server is listening on
     */
    get address(): AddressInfo | null {
        return this._address;
    }

    /**
     * Create an HTTP/2 server (secure or plaintext), attach session tracking, and start listening.
     *
     * @param handler - Request handler (from connectNodeAdapter)
     * @param config - Transport configuration
     */
    async listen(handler: (req: Http2ServerRequest, res: Http2ServerResponse) => void, config: TransportConfig): Promise<void> {
        const { tls, allowHTTP1 = true, handshakeTimeout = 30_000, http2Options } = config;

        const port = config.port ?? env.get("PORT").default(5000).asPortNumber();
        const host = config.host ?? env.get("LISTEN").default("0.0.0.0").asString();

        // Read TLS certificates if configured
        const tlsCerts = tls ? readTLSCertificates(tls) : undefined;

        // Create HTTP/2 server (secure or plaintext)
        this._server = tlsCerts
            ? createSecureServer(
                  {
                      key: tlsCerts.key,
                      cert: tlsCerts.cert,
                      allowHTTP1,
                      enableTrace: false,
                      handshakeTimeout,
                      ...http2Options,
                  },
                  handler,
              )
            : createHttp2Server(
                  {
                      allowHTTP1,
                      enableTrace: false,
                      ...http2Options,
                  },
                  handler,
              );

        // Track HTTP/2 sessions for force close on timeout
        this._server.on("session", (session: ServerHttp2Session) => {
            this._sessions.add(session);
            session.on("close", () => {
                this._sessions.delete(session);
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
