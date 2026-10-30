/**
 * A raw HTTP endpoint written the way the protocol guide writes it: the handler gets
 * a `NodeResponse`, which is an HTTP/1.1 or an HTTP/2 response, and uses only what
 * both classes share (`statusCode`, `setHeader`, `end`). The same handler
 * must produce the same status, headers and body on either transport.
 */

import assert from "node:assert";
import { request as http1Request } from "node:http";
import { connect as http2Connect } from "node:http2";
import { after, before, describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";
import type { NodeRequest, NodeResponse, ProtocolRegistration, Server } from "../../src/types.ts";

const customHealth: ProtocolRegistration = {
    name: "custom-health",
    register(): void {},
    httpHandler(req: NodeRequest, res: NodeResponse): boolean {
        if (req.url === "/healthz" && req.method === "GET") {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }
        return false;
    },
};

interface RawResponse {
    readonly status: number | undefined;
    readonly contentType: string | undefined;
    readonly body: string;
}

function getOverHttp1(port: number, path: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = http1Request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end();
    });
}

function getOverHttp2(port: number, path: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const session = http2Connect(`http://127.0.0.1:${port}`);
        session.on("error", reject);
        const req = session.request({ ":path": path, ":method": "GET" });
        let status: number | undefined;
        let contentType: string | undefined;
        const chunks: Buffer[] = [];
        req.on("response", (headers) => {
            status = Number(headers[":status"]);
            const value = headers["content-type"];
            contentType = typeof value === "string" ? value : undefined;
        });
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            session.close();
            resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") });
        });
        req.on("error", reject);
        req.end();
    });
}

describe("raw httpHandler written with the members both response classes share", () => {
    // Without TLS, `allowHTTP1: true` serves HTTP/1.1 and `false` serves plaintext HTTP/2:
    // one server per transport, so each handler call sees the matching response class.
    const servers: Server[] = [];
    const ports = { http1: 0, http2: 0 };

    before(async () => {
        for (const [key, allowHTTP1] of [
            ["http1", true],
            ["http2", false],
        ] as const) {
            const server = createServer({ services: [], port: 0, host: "127.0.0.1", allowHTTP1, protocols: [customHealth] });
            await server.start();
            servers.push(server);
            ports[key] = server.address?.port ?? 0;
        }
    });

    after(async () => {
        for (const server of servers) {
            if (server.state === "running") await server.stop();
        }
    });

    for (const [label, key, get] of [
        ["HTTP/1.1", "http1", getOverHttp1],
        ["HTTP/2", "http2", getOverHttp2],
    ] as const) {
        it(`${label}: answers 200 with the header and the body the handler wrote`, async () => {
            const res = await get(ports[key], "/healthz");
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.contentType, "application/json");
            assert.deepStrictEqual(JSON.parse(res.body), { status: "ok" });
        });

        it(`${label}: a path the handler declines still gets 404`, async () => {
            const res = await get(ports[key], "/elsewhere");
            assert.strictEqual(res.status, 404);
        });
    }
});
