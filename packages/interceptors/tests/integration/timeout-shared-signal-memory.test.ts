/**
 * Memory behaviour of the timeout interceptor when many in-process calls share one
 * long-lived AbortSignal (an application-wide shutdown signal, for example).
 *
 * Measured, not asserted structurally: the retained objects hang off the shared signal
 * and the handler context, so only the heap shows them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

const collect = globalThis.gc;

/** Heap in megabytes after two full collections. */
function heapMegabytes(gc: () => void): number {
    gc();
    gc();
    return process.memoryUsage().heapUsed / 1e6;
}

/** The kind of call the interceptor sees. */
type CallShape = "unary" | "server-stream" | "client-stream" | "bidi-stream";

/**
 * Runs `perform` for a warm-up and then measures the heap across `calls` more, all
 * carrying the same signal. Each call is read to the end, as a real reader does.
 */
async function measure(options: { perform: (signal: AbortSignal) => Promise<void>; calls: number; gc: () => void }): Promise<number> {
    const { perform, calls, gc } = options;
    const shared = new AbortController();
    for (let i = 0; i < 1000; i++) {
        await perform(shared.signal);
    }
    const before = heapMegabytes(gc);
    for (let i = 0; i < calls; i++) {
        await perform(shared.signal);
    }
    return heapMegabytes(gc) - before;
}

/** Heap growth over `calls` in-process calls of `shape` that all carry the same signal. */
async function heapGrowthMegabytes(options: { interceptors: Interceptor[]; shape: CallShape; calls: number; gc: () => void }): Promise<number> {
    const { interceptors, shape, calls, gc } = options;
    const server = createServer({
        interceptors,
        services: [
            defineService(EchoService, {
                async echo(request) {
                    return create(EchoResponseSchema, { message: request.message, timestamp: 0n });
                },
                async secureEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
                async rateLimitedEcho() {
                    return create(EchoResponseSchema, { message: "unused", timestamp: 0n });
                },
            }),
            defineService(StreamingService, {
                echo: (request) => request,
                async *server(request) {
                    yield request;
                },
                async client(requests) {
                    let total = 0;
                    for await (const _ of requests) total++;
                    return create(CountSchema, { total });
                },
                async *bidi(requests) {
                    yield* requests;
                },
            }),
        ],
    });
    const transport = createLocalTransport(server);
    const echo = createClient(EchoService, transport);
    const streaming = createClient(StreamingService, transport);
    const item = () => create(ItemSchema, { value: "payload", sequence: 1 });
    async function* items() {
        yield item();
    }
    const perform: Record<CallShape, (signal: AbortSignal) => Promise<void>> = {
        unary: async (signal) => {
            await echo.echo(create(EchoRequestSchema, { message: "measured" }), { signal });
        },
        "server-stream": async (signal) => {
            for await (const _ of streaming.server(item(), { signal }));
        },
        "client-stream": async (signal) => {
            await streaming.client(items(), { signal });
        },
        "bidi-stream": async (signal) => {
            for await (const _ of streaming.bidi(items(), { signal }));
        },
    };
    try {
        return await measure({ perform: perform[shape], calls, gc });
    } finally {
        if (server.isRunning) await server.stop();
    }
}

describe("timeout interceptor with a long-lived caller signal", { timeout: 240_000, skip: collect === undefined ? "needs --expose-gc, which the package test script passes" : false }, () => {
    const shapes: Array<{ shape: CallShape; options: { skipStreaming?: boolean } }> = [
        { shape: "unary", options: {} },
        // The interceptor covers streams only when they opt in.
        { shape: "server-stream", options: { skipStreaming: false } },
        { shape: "client-stream", options: { skipStreaming: false } },
        { shape: "bidi-stream", options: { skipStreaming: false } },
    ];

    for (const { shape, options } of shapes) {
        it(`retains nothing per completed ${shape} call`, async () => {
            const gc = collect as () => void;
            const calls = 6000;

            // The same loop without the interceptor shows what the transport and the handler keep on their own.
            const baseline = await heapGrowthMegabytes({ interceptors: [], shape, calls, gc });
            const withTimeout = await heapGrowthMegabytes({ interceptors: [createTimeoutInterceptor({ duration: 5_000, ...options })], shape, calls, gc });

            // Without the fix the timeout run kept 8 to 30 KB per call (50 to 190 MB for 6000 calls) on top of the
            // baseline. 10 MB is under 1700 bytes per call: far under the leak, over the swing of a few MB that a
            // heap reading shows when the whole suite runs in one process. A baseline that shrank (collection of
            // earlier tests' garbage) does not widen the allowance.
            const retained = withTimeout - Math.max(baseline, 0);
            assert.ok(retained < 10, `the timeout interceptor retained ${retained.toFixed(1)} MB over the baseline of ${baseline.toFixed(1)} MB for ${calls} ${shape} calls`);
        });
    }
});
