/**
 * The handler's cleanup after a cancelled streaming call runs in the context
 * the call was created in, not in the context that happened to notice the
 * cancellation.
 *
 * A cancellation is delivered by whoever sees it first: a socket event, a
 * deadline timer, the caller's own `abort()`. An interceptor that scopes an
 * AsyncLocalStorage value (a tenant, a trace, a verified identity) around the
 * call expects the handler's `finally` to still see it; otherwise cleanup code
 * that audits, scopes a release or tags telemetry runs without it. The
 * interceptor here is deliberately independent of any authentication package:
 * it scopes a value of its own around creation and every iterator operation,
 * exactly as a context-carrying interceptor has to for generator handlers.
 */

import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/**
 * Overlapping pairs per cell. The defect is deterministic: with the cleanup left unbound every cleanup of an
 * in-process call that is parked on a yield saw the wrong scope, so a few dozen pairs already turn the cell red.
 * Set CANCEL_CONTEXT_PAIRS=250 for deeper local runs.
 */
const PAIRS = Number(process.env.CANCEL_CONTEXT_PAIRS ?? 60);

const scope = new AsyncLocalStorage<string>();

/** Scopes `value` around the chain, the creation of the response iterator and each of its operations. */
const scoping =
    (header: string): Interceptor =>
    (next) =>
    async (req) => {
        const value = req.header.get(header) ?? "none";
        const res = await scope.run(value, () => next(req));
        if (!res.stream) {
            return res;
        }
        const source = res.message;
        return {
            ...res,
            message: {
                [Symbol.asyncIterator]() {
                    const iterator = scope.run(value, () => source[Symbol.asyncIterator]());
                    return {
                        next: (...args: [] | [unknown]) => scope.run(value, () => iterator.next(...args)),
                        return: (...args: [] | [unknown]) => scope.run(value, () => iterator.return?.(...args) ?? Promise.resolve({ done: true as const, value: undefined })),
                    };
                },
            },
        };
    };

interface Seen {
    tag: string;
    inFinally: string | undefined;
    runs: number;
}

function routes(seen: Map<string, Seen>, pace: "yield-only" | "slow-await") {
    const finish = (tag: string) => {
        const entry = seen.get(tag) ?? { tag, inFinally: undefined, runs: 0 };
        entry.runs++;
        entry.inFinally = scope.getStore();
        seen.set(tag, entry);
    };
    return defineService(StreamingService, {
        echo: async (req) => create(ItemSchema, { value: req.value }),
        client: async () => {
            throw new Error("unused");
        },
        server: async function* (_req, ctx) {
            const tag = ctx.requestHeader.get("x-tag") ?? "none";
            try {
                for (let i = 0; ; i++) {
                    // Over HTTP/2 the server pumps this endless generator into the socket as fast as it can; a short
                    // pause keeps that from starving the event loop without changing where the handler is parked.
                    await sleep(pace === "slow-await" ? 100 : 2);
                    yield create(ItemSchema, { value: tag, sequence: i });
                }
            } finally {
                finish(tag);
            }
        },
        bidi: async function* (requests, ctx) {
            const tag = ctx.requestHeader.get("x-tag") ?? "none";
            try {
                for await (const _message of requests) {
                    if (pace === "slow-await") {
                        await sleep(100);
                    }
                    yield create(ItemSchema, { value: tag });
                }
            } finally {
                finish(tag);
            }
        },
    });
}

const started: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

async function* inputs(tag: string) {
    for (let i = 0; ; i++) {
        yield create(ItemSchema, { value: tag, sequence: i });
        await sleep(5);
    }
}

for (const transport of ["local", "http"] as const) {
    for (const method of ["server", "bidi"] as const) {
        for (const pace of ["yield-only", "slow-await"] as const) {
            describe(`${transport} ${method} (${pace}): cancellation cleanup`, () => {
                it(`sees the scope of the call it belongs to, for ${PAIRS} overlapping pairs`, { timeout: 120_000 }, async () => {
                    const seen = new Map<string, Seen>();
                    const server = createServer({ services: [routes(seen, pace)], port: 0, allowHTTP1: false, interceptors: [scoping("x-scope")], shutdown: { timeout: 1_000 } });
                    started.push(server);
                    await server.start();
                    const client = transport === "local" ? server.localClient(StreamingService) : createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));

                    const cancel = async (tag: string) => {
                        const abort = new AbortController();
                        const headers = { "x-scope": tag, "x-tag": tag };
                        const first = create(ItemSchema, { value: tag });
                        const stream = method === "server" ? client.server(first, { headers, signal: abort.signal }) : client.bidi(inputs(tag), { headers, signal: abort.signal });
                        const iterator = stream[Symbol.asyncIterator]();
                        await iterator.next();
                        const pending = pace === "slow-await" ? iterator.next() : undefined;
                        await sleep(pace === "slow-await" ? 20 : 5);
                        // The abort is raised from a callback of its own, a context that never entered the call's scope.
                        await new Promise<void>((resolve) => setImmediate(() => (abort.abort(), resolve())));
                        await (pending ?? iterator.next()).then(
                            () => {},
                            () => {},
                        );
                    };

                    for (let i = 0; i < PAIRS; i++) {
                        await Promise.all([cancel(`pair-${i}-A`), cancel(`pair-${i}-B`)]);
                        if (transport === "http") {
                            // Hundreds of stream resets in a burst trip HTTP/2 flood protection (ENHANCE_YOUR_CALM), which is not what is under test.
                            await sleep(10);
                        }
                    }
                    const deadline = Date.now() + 10_000;
                    while (seen.size < PAIRS * 2 && Date.now() < deadline) {
                        await sleep(20);
                    }
                    await sleep(100);

                    const wrong = [...seen.values()].filter((entry) => entry.runs !== 1 || entry.inFinally !== entry.tag);
                    assert.strictEqual(seen.size, PAIRS * 2, "every call ran its cleanup");
                    assert.deepStrictEqual(wrong.slice(0, 3), [], `${wrong.length} cleanups saw the wrong scope or ran more than once`);
                });
            });
        }
    }
}
