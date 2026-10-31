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
import { createTimeoutInterceptor } from "../../src/timeout.ts";

const collect = globalThis.gc;

/** Heap in megabytes after two full collections. */
function heapMegabytes(gc: () => void): number {
    gc();
    gc();
    return process.memoryUsage().heapUsed / 1e6;
}

/** Heap growth over `calls` in-process calls that all carry the same signal. */
async function heapGrowthMegabytes(options: { interceptors: Interceptor[]; calls: number; gc: () => void }): Promise<number> {
    const { interceptors, calls, gc } = options;
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
        ],
    });
    const client = createClient(EchoService, createLocalTransport(server));
    const shared = new AbortController();
    try {
        for (let i = 0; i < 300; i++) {
            await client.echo(create(EchoRequestSchema, { message: "warm-up" }), { signal: shared.signal });
        }
        const before = heapMegabytes(gc);
        for (let i = 0; i < calls; i++) {
            await client.echo(create(EchoRequestSchema, { message: "measured" }), { signal: shared.signal });
        }
        return heapMegabytes(gc) - before;
    } finally {
        if (server.isRunning) await server.stop();
    }
}

describe("timeout interceptor with a long-lived caller signal", { timeout: 120_000, skip: collect === undefined ? "needs --expose-gc, which the package test script passes" : false }, () => {
    it("retains nothing per completed call", async () => {
        const gc = collect as () => void;
        const calls = 5000;

        // The same loop without the interceptor shows what the transport and the handler keep on their own.
        const baseline = await heapGrowthMegabytes({ interceptors: [], calls, gc });
        const withTimeout = await heapGrowthMegabytes({ interceptors: [createTimeoutInterceptor({ duration: 5_000 })], calls, gc });

        // Before the fix the timeout run kept about 8 KB per call (40 MB for 5000 calls) on top of the baseline.
        // 4 MB is 800 bytes per call: far under the leak, far over collection noise.
        assert.ok(withTimeout - baseline < 4, `the timeout interceptor retained ${(withTimeout - baseline).toFixed(1)} MB over the baseline of ${baseline.toFixed(1)} MB for ${calls} calls`);
    });
});
