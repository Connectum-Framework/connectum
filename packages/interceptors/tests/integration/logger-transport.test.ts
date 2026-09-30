/**
 * Logger `includeTransport` against real transports.
 *
 * The logger recognises an in-process call by a request marker that
 * `@connectum/core` sets inside `createLocalTransport`. Core does not export
 * that marker, so the logger repeats its literals. These tests run real calls
 * through `createServer` — one through `server.localClient()`, one over HTTP/2
 * with a gRPC client — and assert the tag on every logged line. If core ever
 * changes the marker, the in-process call is logged as `http` and the test
 * fails; a mocked request could not catch that drift.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";

const ECHO_PATH = "/streaming.v1.StreamingService/Echo";
const SERVER_STREAM_PATH = "/streaming.v1.StreamingService/Server";

function streamingRoutes() {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server(req) {
            for (let i = 0; i < 2; i++) {
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
            }
        },
        async client(requests) {
            let total = 0;
            for await (const _ of requests) total++;
            return { total };
        },
        async *bidi(requests) {
            for await (const item of requests) yield item;
        },
    });
}

/** Collects the message argument of every logger call. */
function captureLines(): { lines: string[]; logger: (message: string) => void } {
    const lines: string[] = [];
    return { lines, logger: (message: string) => lines.push(message) };
}

/** Replaces the variable duration so lines compare exactly. */
function normalise(lines: string[]): string[] {
    return lines.map((line) => line.replace(/completed in \d+(\.\d+)?ms$/, "completed in <ms>"));
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
    let count = 0;
    for await (const _ of stream) count++;
    return count;
}

describe("logger includeTransport over real transports", () => {
    const serverLog = captureLines();
    let server: Server;
    let httpClient: Client<typeof StreamingService>;

    before(async () => {
        server = createServer({
            services: [streamingRoutes()],
            port: 0,
            // A gRPC client over plaintext HTTP/2 needs the server to refuse the HTTP/1 upgrade.
            allowHTTP1: false,
            interceptors: [createLoggerInterceptor({ includeTransport: true, logger: serverLog.logger })],
        });
        await server.start();
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        httpClient = createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        await server.stop();
    });

    it("tags every line of a unary call made through server.localClient() as in-process", async () => {
        serverLog.lines.length = 0;
        await server.localClient(StreamingService).echo(create(ItemSchema, { value: "local" }));

        assert.deepStrictEqual(normalise(serverLog.lines), [
            `RPC [in-process] ${ECHO_PATH} request`,
            `RPC [in-process] ${ECHO_PATH} response`,
            `RPC [in-process] ${ECHO_PATH} completed in <ms>`,
        ]);
    });

    it("tags every line of a unary call over HTTP/2 as http", async () => {
        serverLog.lines.length = 0;
        await httpClient.echo(create(ItemSchema, { value: "remote" }));

        assert.deepStrictEqual(normalise(serverLog.lines), [`RPC [http] ${ECHO_PATH} request`, `RPC [http] ${ECHO_PATH} response`, `RPC [http] ${ECHO_PATH} completed in <ms>`]);
    });

    it("still tags an HTTP call as http when the remote caller forges the in-process marker", async () => {
        serverLog.lines.length = 0;
        const port = server.address?.port;
        const forging = createClient(
            StreamingService,
            createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [
                    (next) => (req) => {
                        req.header.set("connectum-internal-transport", "in-process");
                        return next(req);
                    },
                ],
            }),
        );
        await forging.echo(create(ItemSchema, { value: "forged" }));

        assert.deepStrictEqual(normalise(serverLog.lines), [`RPC [http] ${ECHO_PATH} request`, `RPC [http] ${ECHO_PATH} response`, `RPC [http] ${ECHO_PATH} completed in <ms>`]);
    });

    it("tags the stream lines of a server-streaming call per transport", async () => {
        serverLog.lines.length = 0;
        assert.strictEqual(await drain(server.localClient(StreamingService).server(create(ItemSchema, { value: "s" }))), 2);
        const localLines = normalise(serverLog.lines);

        serverLog.lines.length = 0;
        assert.strictEqual(await drain(httpClient.server(create(ItemSchema, { value: "s" }))), 2);
        const httpLines = normalise(serverLog.lines);

        for (const [tag, lines] of [
            ["in-process", localLines],
            ["http", httpLines],
        ] as const) {
            assert.deepStrictEqual(lines.slice().sort(), [
                `RPC [${tag}] ${SERVER_STREAM_PATH} completed in <ms>`,
                `STREAM [${tag}] ${SERVER_STREAM_PATH} request`,
                `STREAM [${tag}] ${SERVER_STREAM_PATH} response`,
                `STREAM [${tag}] ${SERVER_STREAM_PATH} response`,
            ]);
        }
    });

    it("tags a client-side logger on createLocalTransport as in-process", async () => {
        const clientLog = captureLines();
        const transport = createLocalTransport(server, {
            interceptors: [createLoggerInterceptor({ includeTransport: true, logger: clientLog.logger })],
        });
        await createClient(StreamingService, transport).echo(create(ItemSchema, { value: "client-side" }));

        assert.deepStrictEqual(normalise(clientLog.lines), [
            `RPC [in-process] ${ECHO_PATH} request`,
            `RPC [in-process] ${ECHO_PATH} response`,
            `RPC [in-process] ${ECHO_PATH} completed in <ms>`,
        ]);
    });

    it("leaves lines untagged when includeTransport is not set", async () => {
        const defaultLog = captureLines();
        const plain = createServer({
            services: [streamingRoutes()],
            interceptors: [createLoggerInterceptor({ logger: defaultLog.logger })],
        });
        await plain.localClient(StreamingService).echo(create(ItemSchema, { value: "plain" }));

        assert.deepStrictEqual(normalise(defaultLog.lines), [`RPC ${ECHO_PATH} request`, `RPC ${ECHO_PATH} response`, `RPC ${ECHO_PATH} completed in <ms>`]);
    });
});
