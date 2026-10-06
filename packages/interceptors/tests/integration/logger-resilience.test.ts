/**
 * Logger interceptor against real server calls.
 *
 * The logger sits on every RPC path, so a defect in it changes the outcome of
 * calls it was only meant to observe. These tests run real calls through
 * `createServer` (in-process client and HTTP/2 gRPC client) and assert what the
 * caller sees and what the sink receives:
 *
 * - a failing log sink never changes the response or the error of the call;
 * - a failed call is logged with its Connect code and the error reaches the
 *   caller unchanged;
 * - for streaming responses the completion line comes after the last message
 *   and the duration covers the whole stream;
 * - a client-streaming call (stream in, single message out) is not broken by
 *   response-stream wrapping.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { CountSchema, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";

const ECHO_PATH = "/streaming.v1.StreamingService/Echo";
const SERVER_PATH = "/streaming.v1.StreamingService/Server";
const CLIENT_PATH = "/streaming.v1.StreamingService/Client";
const STREAM_STEP_MS = 60;

function routes() {
    return defineService(StreamingService, {
        echo: (req) => {
            if (req.value === "missing") {
                throw new ConnectError("item not found", Code.NotFound);
            }
            return create(ItemSchema, { value: req.value, sequence: req.sequence });
        },
        async *server(req) {
            for (let i = 0; i < 3; i++) {
                await sleep(STREAM_STEP_MS);
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
            }
        },
        async client(requests) {
            let total = 0;
            for await (const _ of requests) total++;
            return create(CountSchema, { total });
        },
        async *bidi(requests) {
            for await (const item of requests) yield item;
        },
    });
}

function capture(): { lines: string[]; logger: (message: string, ...args: unknown[]) => void } {
    const lines: string[] = [];
    return { lines, logger: (message: string) => lines.push(message) };
}

function failingSink(): (message: string, ...args: unknown[]) => void {
    return () => {
        throw new Error("log sink is down");
    };
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
    let count = 0;
    for await (const _ of stream) count++;
    return count;
}

function durationMs(line: string | undefined): number {
    const match = line?.match(/completed in (\d+(?:\.\d+)?)ms$/);
    assert.ok(match, `expected a completion line, got: ${line}`);
    return Number(match[1]);
}

interface Harness {
    server: Server;
    http: Client<typeof StreamingService>;
    local: Client<typeof StreamingService>;
}

async function start(logger: (message: string, ...args: unknown[]) => void): Promise<Harness> {
    const server = createServer({
        services: [routes()],
        port: 0,
        allowHTTP1: false,
        interceptors: [createLoggerInterceptor({ logger })],
    });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server must bind a port");
    return {
        server,
        http: createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${port}` })),
        local: server.localClient(StreamingService),
    };
}

describe("logger interceptor on real calls: failed calls", () => {
    const sink = capture();
    let h: Harness;

    before(async () => {
        h = await start(sink.logger);
    });
    after(async () => {
        await h.server.stop();
    });

    it("logs a failed call with its Connect code and delivers the original error to the caller", async () => {
        for (const client of [h.local, h.http]) {
            sink.lines.length = 0;
            await assert.rejects(
                () => client.echo(create(ItemSchema, { value: "missing" })),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.NotFound);
                    assert.strictEqual(err.rawMessage, "item not found");
                    return true;
                },
            );
            assert.ok(
                sink.lines.some((line) => line === `RPC ${ECHO_PATH} failed with NotFound`),
                `expected a failure line with the code, got: ${JSON.stringify(sink.lines)}`,
            );
            assert.ok(sink.lines.at(-1)?.startsWith(`RPC ${ECHO_PATH} completed in `), "completion line must come last");
        }
    });
});

describe("logger interceptor on real calls: streaming completion", () => {
    const sink = capture();
    let h: Harness;

    before(async () => {
        h = await start(sink.logger);
    });
    after(async () => {
        await h.server.stop();
    });

    it("logs the completion line after the last streamed message with a duration that covers the whole stream", async () => {
        for (const client of [h.local, h.http]) {
            sink.lines.length = 0;
            assert.strictEqual(await drain(client.server(create(ItemSchema, { value: "s" }))), 3);

            const last = sink.lines.at(-1);
            assert.ok(last?.startsWith(`RPC ${SERVER_PATH} completed in `), `completion must be the last line, got: ${JSON.stringify(sink.lines)}`);
            assert.strictEqual(sink.lines.filter((line) => line === `STREAM ${SERVER_PATH} response`).length, 3);
            assert.ok(durationMs(last) >= STREAM_STEP_MS * 3 - 15, `duration ${durationMs(last)}ms must cover three ${STREAM_STEP_MS}ms steps`);
        }
    });
});

describe("logger interceptor on real calls: client-streaming", () => {
    const sink = capture();
    let h: Harness;

    before(async () => {
        h = await start(sink.logger);
    });
    after(async () => {
        await h.server.stop();
    });

    it("returns the single response message of a client-streaming call intact", async () => {
        async function* items() {
            yield create(ItemSchema, { value: "a" });
            yield create(ItemSchema, { value: "b" });
        }
        for (const client of [h.local, h.http]) {
            sink.lines.length = 0;
            const result = await client.client(items());
            assert.strictEqual(result.total, 2);
            assert.ok(sink.lines.some((line) => line.startsWith(`RPC ${CLIENT_PATH} completed in `)));
        }
    });
});

describe("logger interceptor on real calls: failing log sink", () => {
    let h: Harness;

    before(async () => {
        h = await start(failingSink());
    });
    after(async () => {
        await h.server.stop();
    });

    it("answers a unary call normally when every log write throws", async () => {
        for (const client of [h.local, h.http]) {
            const res = await client.echo(create(ItemSchema, { value: "ok", sequence: 7 }));
            assert.strictEqual(res.value, "ok");
            assert.strictEqual(res.sequence, 7);
        }
    });

    it("keeps the original error of a failed call when every log write throws", async () => {
        for (const client of [h.local, h.http]) {
            await assert.rejects(
                () => client.echo(create(ItemSchema, { value: "missing" })),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.NotFound, "a log failure must not turn the real error into Internal");
                    return true;
                },
            );
        }
    });

    it("delivers every message of a stream when every log write throws", async () => {
        for (const client of [h.local, h.http]) {
            assert.strictEqual(await drain(client.server(create(ItemSchema, { value: "s" }))), 3);
        }
    });
});

describe("logger interceptor on the client side of a client-streaming call", () => {
    const sink = capture();
    let server: Server;

    before(async () => {
        server = createServer({ services: [routes()], port: 0, allowHTTP1: false });
        await server.start();
    });
    after(async () => {
        await server.stop();
    });

    it("keeps the single response message of a client-streaming call intact", async () => {
        const port = server.address?.port;
        const client = createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${port}`, interceptors: [createLoggerInterceptor({ logger: sink.logger })] }));
        async function* items() {
            yield create(ItemSchema, { value: "a" });
            yield create(ItemSchema, { value: "b" });
            yield create(ItemSchema, { value: "c" });
        }
        const result = await client.client(items());
        assert.strictEqual(result.total, 3);
        assert.ok(
            sink.lines.some((line) => line.startsWith(`RPC ${CLIENT_PATH} completed in `)),
            `a client-streaming call is closed out in the log, got: ${JSON.stringify(sink.lines)}`,
        );
    });
});
