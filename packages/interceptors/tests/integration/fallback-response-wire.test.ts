/**
 * Fallback response on the wire, through real transports.
 *
 * When a handler throws and the fallback interceptor is enabled, the caller must
 * receive the fallback message over every supported protocol, and the response must
 * carry only the protocol headers it needs: never a header the caller sent (its
 * credentials, the identity an authentication interceptor wrote into the request,
 * hop-by-hop fields). Oracles: the Connect and gRPC protocol grammars (a gRPC or
 * gRPC-web response ends with a `grpc-status` trailer, a Connect unary response
 * keeps its `content-type`), RFC 9112 section 6.3 (`Transfer-Encoding` next to
 * `Content-Length` is an error) and RFC 9113 section 8.2.2 (no connection-specific
 * fields in an HTTP/2 response). A unit test on the interceptor alone cannot show
 * that the protocol layer keeps what the interceptor returns, so these tests run a
 * real `createServer` and read the bytes and the client-visible headers.
 */

import assert from "node:assert";
import { once } from "node:events";
import http2 from "node:http2";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { createAuthInterceptor } from "../../../auth/src/auth-interceptor.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const FALLBACK_MESSAGE = "fallback-message";

/** Headers the caller sends; none of them may come back. */
const CALLER_HEADERS = {
    authorization: "Bearer caller-token",
    cookie: "sid=caller-session",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "x-forwarded-for": "10.0.0.5",
} as const;

/** Names that must be absent from every fallback response, besides any `x-auth-*` field. */
const FORBIDDEN_RESPONSE_HEADERS = ["authorization", "cookie", "traceparent", "x-forwarded-for", "host", "user-agent", "te", "transfer-encoding"] as const;

function failingRoutes() {
    return defineService(EchoService, {
        echo: () => {
            throw new ConnectError("handler failed", Code.Internal);
        },
        secureEcho: () => ({ message: "unused" }),
        rateLimitedEcho: () => ({ message: "unused" }),
    });
}

/** An authentication interceptor that writes the identity into the request header, as `propagateHeaders: true` does. */
function propagatingAuth(): Interceptor {
    return createAuthInterceptor({
        verifyCredentials: () => ({
            subject: "alice",
            name: "Alice",
            roles: ["admin"],
            scopes: ["read"],
            claims: { tenant: "t1" },
            type: "jwt",
        }),
        propagateHeaders: true,
    });
}

/** Authentication outside the chain, then the default chain with only the fallback standing in for the error handler. */
function serverChain(): Interceptor[] {
    return [
        propagatingAuth(),
        ...createDefaultInterceptors({
            errorHandler: false,
            fallback: { handler: () => create(EchoResponseSchema, { message: FALLBACK_MESSAGE }) },
        }),
    ];
}

async function startServer(options: { allowHTTP1: boolean; interceptors: Interceptor[] }): Promise<{ server: Server; port: number }> {
    const server = createServer({ services: [failingRoutes()], interceptors: options.interceptors, port: 0, allowHTTP1: options.allowHTTP1 });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server must bind a port");
    return { server, port };
}

/** The set of response header names in lower case. */
function namesOf(headers: Headers): string[] {
    return [...headers.keys()];
}

function assertNoCallerHeaders(names: readonly string[], context: string, allowed: readonly string[] = []): void {
    for (const forbidden of FORBIDDEN_RESPONSE_HEADERS) {
        if (allowed.includes(forbidden)) continue;
        assert.ok(!names.includes(forbidden), `${context}: response must not carry ${forbidden}, got ${JSON.stringify(names)}`);
    }
    const identity = names.filter((name) => name.startsWith("x-auth-"));
    assert.deepStrictEqual(identity, [], `${context}: response must not carry the identity written by authentication`);
}

describe("fallback response on the wire", () => {
    let h2: { server: Server; port: number };
    let h1: { server: Server; port: number };

    before(async () => {
        h2 = await startServer({ allowHTTP1: false, interceptors: serverChain() });
        h1 = await startServer({ allowHTTP1: true, interceptors: serverChain() });
    });

    after(async () => {
        await h2.server.stop();
        await h1.server.stop();
    });

    // `framing` lists a forbidden name that the server's own HTTP/1.1 framing legitimately
    // produces: a gRPC-web response has no length known up front (its status travels in the
    // body), so Node frames it with `Transfer-Encoding: chunked` whatever the request carried.
    const clients: ReadonlyArray<{ name: string; protocol: "h2" | "h1"; framing: readonly string[]; transport: (baseUrl: string) => Transport }> = [
        { name: "Connect over HTTP/2 with JSON", protocol: "h2", framing: [], transport: (baseUrl) => createConnectTransport({ baseUrl, httpVersion: "2", useBinaryFormat: false }) },
        { name: "Connect over HTTP/2 with protobuf", protocol: "h2", framing: [], transport: (baseUrl) => createConnectTransport({ baseUrl, httpVersion: "2", useBinaryFormat: true }) },
        { name: "gRPC over HTTP/2", protocol: "h2", framing: [], transport: (baseUrl) => createGrpcTransport({ baseUrl }) },
        { name: "gRPC-web over HTTP/2", protocol: "h2", framing: [], transport: (baseUrl) => createGrpcWebTransport({ baseUrl, httpVersion: "2" }) },
        { name: "Connect over HTTP/1.1 (chunked request body)", protocol: "h1", framing: [], transport: (baseUrl) => createConnectTransport({ baseUrl, httpVersion: "1.1" }) },
        { name: "gRPC-web over HTTP/1.1", protocol: "h1", framing: ["transfer-encoding"], transport: (baseUrl) => createGrpcWebTransport({ baseUrl, httpVersion: "1.1" }) },
    ];

    for (const { name, protocol, framing, transport } of clients) {
        it(`${name}: the call resolves with the fallback message and no header of the caller comes back`, async () => {
            const port = protocol === "h2" ? h2.port : h1.port;
            const client = createClient(EchoService, transport(`http://127.0.0.1:${port}`));
            let responseHeader: Headers | undefined;
            let responseTrailer: Headers | undefined;

            const response = await client.echo(create(EchoRequestSchema, { message: "ping" }), {
                headers: CALLER_HEADERS,
                onHeader: (header) => {
                    responseHeader = header;
                },
                onTrailer: (trailer) => {
                    responseTrailer = trailer;
                },
            });

            assert.strictEqual(response.message, FALLBACK_MESSAGE);
            assert.ok(responseHeader, "the client must observe the response header");
            const names = namesOf(responseHeader);
            assertNoCallerHeaders(names, name, framing);
            assert.ok(names.includes("content-type"), `${name}: the response must carry content-type, got ${JSON.stringify(names)}`);
            if (name.startsWith("gRPC")) {
                assert.strictEqual(responseTrailer?.get("grpc-status") ?? responseHeader.get("grpc-status"), "0", `${name}: the call must end with grpc-status 0`);
            }
        });
    }

    // The bytes of a gRPC response, read without a Connect client: the protocol layer must be
    // left with exactly the headers HTTP/2 needs and the status trailer.
    it("raw gRPC over HTTP/2: response headers are :status, content-type and date; trailers are exactly grpc-status 0", async () => {
        const session = http2.connect(`http://127.0.0.1:${h2.port}`);
        try {
            const result = await new Promise<{ headers: http2.IncomingHttpHeaders; trailers: http2.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
                const stream = session.request({
                    ":method": "POST",
                    ":path": "/echo.v1.EchoService/Echo",
                    "content-type": "application/grpc+proto",
                    te: "trailers",
                    ...CALLER_HEADERS,
                });
                const chunks: Buffer[] = [];
                let headers: http2.IncomingHttpHeaders = {};
                let trailers: http2.IncomingHttpHeaders = {};
                stream.on("response", (received) => {
                    headers = { ...received };
                });
                stream.on("trailers", (received) => {
                    trailers = { ...received };
                });
                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("end", () => resolve({ headers, trailers, body: Buffer.concat(chunks) }));
                stream.on("error", reject);
                // One gRPC frame: uncompressed flag and a zero length (an empty EchoRequest).
                stream.end(Buffer.alloc(5));
            });

            assert.deepStrictEqual(Object.keys(result.headers).sort(), [":status", "content-type", "date"]);
            assert.strictEqual(result.headers[":status"], 200);
            assert.strictEqual(result.headers["content-type"], "application/grpc+proto");
            // Node adds a symbol-keyed bookkeeping entry to received headers; only named fields count.
            assert.deepStrictEqual(Object.fromEntries(Object.entries(result.trailers)), { "grpc-status": "0" });
            assert.ok(result.body.length > 5, "the body must carry the fallback message frame");
        } finally {
            session.close();
        }
    });

    // The bytes of an HTTP/1.1 response to a request with a fixed Content-Length: a response that
    // repeated the request's Transfer-Encoding next to its own Content-Length would be refused.
    it("raw HTTP/1.1 with Content-Length: no transfer-encoding and no authorization in the response", async () => {
        const body = JSON.stringify({ message: "ping" });
        const socket = net.connect(h1.port, "127.0.0.1");
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        try {
            await once(socket, "connect");
            socket.write(
                [
                    "POST /echo.v1.EchoService/Echo HTTP/1.1",
                    "Host: 127.0.0.1",
                    "Content-Type: application/json",
                    "Connect-Protocol-Version: 1",
                    `Content-Length: ${Buffer.byteLength(body)}`,
                    `Authorization: ${CALLER_HEADERS.authorization}`,
                    `Cookie: ${CALLER_HEADERS.cookie}`,
                    "Connection: close",
                    "",
                    body,
                ].join("\r\n"),
            );
            await once(socket, "close");
        } finally {
            socket.destroy();
        }

        const raw = Buffer.concat(chunks).toString("utf8");
        const separator = raw.indexOf("\r\n\r\n");
        assert.ok(separator > 0, `a complete HTTP response is expected, got ${JSON.stringify(raw)}`);
        const [statusLine = "", ...headerLines] = raw.slice(0, separator).split("\r\n");
        const names = headerLines.map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
        assert.strictEqual(statusLine, "HTTP/1.1 200 OK");
        assertNoCallerHeaders(names, "raw HTTP/1.1");
        assert.ok(!names.includes("transfer-encoding"), "no transfer-encoding next to content-length");
        assert.ok(names.includes("content-type"), `content-type is expected, got ${JSON.stringify(names)}`);
        assert.ok(raw.slice(separator + 4).includes(FALLBACK_MESSAGE), "the body must carry the fallback message");
    });
});

// The same interceptor on a client transport: the server fails, the client-side fallback answers,
// and the headers the call sent must not appear in the response the application observes.
describe("fallback response on a client transport", () => {
    let failing: { server: Server; port: number };

    before(async () => {
        failing = await startServer({ allowHTTP1: false, interceptors: [] });
    });

    after(async () => {
        await failing.server.stop();
    });

    it("res.header holds no header the call sent", async () => {
        const transport = createConnectTransport({
            baseUrl: `http://127.0.0.1:${failing.port}`,
            httpVersion: "2",
            interceptors: [createFallbackInterceptor({ handler: () => create(EchoResponseSchema, { message: FALLBACK_MESSAGE }) })],
        });
        const client = createClient(EchoService, transport);
        let responseHeader: Headers | undefined;

        const response = await client.echo(create(EchoRequestSchema, { message: "ping" }), {
            headers: CALLER_HEADERS,
            onHeader: (header) => {
                responseHeader = header;
            },
        });

        assert.strictEqual(response.message, FALLBACK_MESSAGE);
        assert.ok(responseHeader, "the client must observe the response header");
        const names = namesOf(responseHeader);
        assertNoCallerHeaders(names, "client transport");
        assert.deepStrictEqual(names, ["content-type"], "only the protocol content-type remains");
    });
});
