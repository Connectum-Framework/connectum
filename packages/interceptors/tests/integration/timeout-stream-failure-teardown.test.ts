/**
 * A client-side timeout interceptor that covers streams (`skipStreaming: false`) must not
 * keep an HTTP/2 stream open after the reader's side of the call has ended early or failed.
 *
 * A transport tears its stream down when the signal it was given aborts, and the
 * interceptor sits between that signal and the call's own. The tests watch the far end:
 * the server's handler must see the call end. Two ways to end early: the reader fails to
 * read a message (it is larger than the client's `readMaxBytes`) and the reader stops
 * reading (`break`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { createServer, defineService } from "@connectum/core";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

/**
 * Starts a server whose server-streaming handler sends one message of `payloadSize` bytes
 * and then holds the stream open until its call ends, and runs `read` against a client
 * transport with the timeout interceptor on it. Resolves to what the handler saw.
 */
async function handlerOutcome(options: { payloadSize: number; readMaxBytes?: number; read: (stream: AsyncIterable<unknown>) => Promise<void> }): Promise<"call-ended" | "waited-out"> {
    const { promise: handlerEnded, resolve: endHandler } = Promise.withResolvers<"call-ended" | "waited-out">();
    const server = createServer({
        host: "127.0.0.1",
        port: 0,
        allowHTTP1: false,
        shutdown: { autoShutdown: false, timeout: 100 },
        interceptors: [],
        services: [
            defineService(StreamingService, {
                echo: (request) => request,
                async *server(_request, context) {
                    yield create(ItemSchema, { value: "x".repeat(options.payloadSize), sequence: 1 });
                    try {
                        await sleep(10_000, undefined, { signal: context.signal });
                        endHandler("waited-out");
                    } catch {
                        endHandler("call-ended");
                    }
                },
                async client() {
                    throw new Error("unused");
                },
                async *bidi() {
                    throw new Error("unused");
                },
            }),
        ],
    });
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address?.port}`;
    const session = new Http2SessionManager(baseUrl);
    try {
        const transport = createGrpcTransport({
            baseUrl,
            sessionManager: session,
            ...(options.readMaxBytes === undefined ? {} : { readMaxBytes: options.readMaxBytes }),
            interceptors: [createTimeoutInterceptor({ duration: 5_000, skipStreaming: false })],
        });
        const response = await transport.stream(StreamingService.method.server, new AbortController().signal, undefined, {}, (async function* () {
            yield create(ItemSchema, { value: "payload", sequence: 1 });
        })());
        await options.read(response.message);
        return await handlerEnded;
    } finally {
        session.abort();
        if (server.isRunning) await server.stop();
    }
}

describe("client-side timeout interceptor over HTTP/2 with skipStreaming: false", { timeout: 30_000 }, () => {
    it("the server's handler sees the call end when the client fails to read a response message", async () => {
        const outcome = await handlerOutcome({
            payloadSize: 4096,
            readMaxBytes: 64,
            read: async (stream) => {
                await assert.rejects(
                    async () => {
                        for await (const _ of stream);
                    },
                    (error: unknown) => error instanceof ConnectError && error.code === Code.ResourceExhausted,
                );
            },
        });

        assert.equal(outcome, "call-ended", "the stream stayed open on the server after the client failed to read it");
    });

    it("the server's handler sees the call end when the client stops reading early", async () => {
        const outcome = await handlerOutcome({
            payloadSize: 16,
            read: async (stream) => {
                for await (const _ of stream) break;
            },
        });

        assert.equal(outcome, "call-ended", "the stream stayed open on the server after the client stopped reading it");
    });
});
