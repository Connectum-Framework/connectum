/**
 * A local JWKS endpoint whose answer a test can change while the interceptor under test is running:
 * the key set (a key rotation), an error status, a body that is not JSON, or no answer at all.
 * It counts the requests it receives, so a test can tell a refetch from a cache hit.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWK } from "jose";

/** What the endpoint answers with. */
export type JwksMode = "keys" | "status-500" | "garbage" | "empty-set" | "hang";

export interface SwappableJwks {
    /** The URL to pass as `jwksUri`. */
    readonly url: string;
    /** Requests received so far. */
    readonly hits: () => number;
    /** Publish exactly these keys and answer normally (a key rotation when the set changes). */
    publish(keys: readonly JWK[]): void;
    /** Change how the endpoint answers. */
    setMode(mode: JwksMode): void;
    /** Stop the endpoint and drop requests that are still waiting. */
    close(): Promise<void>;
}

export async function startSwappableJwks(initial: readonly JWK[] = []): Promise<SwappableJwks> {
    let keys: readonly JWK[] = initial;
    let mode: JwksMode = "keys";
    let hits = 0;
    const server: Server = createServer((_req, res) => {
        hits++;
        if (mode === "hang") {
            // Never answered: the caller's own timeout has to end the request.
            return;
        }
        if (mode === "status-500") {
            res.writeHead(500).end("boom");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (mode === "garbage") {
            res.end("<html>not json</html>");
            return;
        }
        res.end(JSON.stringify({ keys: mode === "empty-set" ? [] : keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/jwks`,
        hits: () => hits,
        publish: (next) => {
            keys = next;
            mode = "keys";
        },
        setMode: (next) => {
            mode = next;
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
