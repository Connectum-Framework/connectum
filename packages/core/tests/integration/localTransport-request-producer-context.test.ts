/**
 * The caller's request generator runs in the caller's async context on the
 * in-process transport, exactly as it does over HTTP.
 *
 * In a client-streaming or bidirectional call the messages come from an
 * `AsyncIterable` the caller owns, usually an `async function*`. Over HTTP the
 * client transport pumps that generator into the socket, so its body runs in
 * the context of the call site. In-process there is no socket: the server-side
 * handler pulls the caller's generator directly, from inside its own `for await`.
 * An interceptor that scopes an AsyncLocalStorage value around the handler
 * (a verified identity, a trace, a tenant) would then also scope the caller's
 * generator, so code in the caller's own process would observe the server's
 * values instead of its own. The transport binds every step of the request
 * iterator to the context in which the call was made.
 *
 * The scoping interceptor here is independent of any authentication package:
 * it scopes a value of its own around the chain, the creation of the response
 * iterator and each of its operations, exactly as a context-carrying server
 * interceptor has to for generator handlers.
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
import { createLocalTransport } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const PAIRS = Number(process.env.PRODUCER_CONTEXT_PAIRS ?? 10);
const MESSAGES = 3;

const scope = new AsyncLocalStorage<string>();

/** Scopes the value of `header` around the chain, the creation of the response iterator and each of its operations. */
const serverScoping: Interceptor = (next) => async (req) => {
    const value = `server:${req.header.get("x-tag") ?? "none"}`;
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

/** A client-side interceptor that scopes its own value around the call, as a tracing client interceptor does. */
const clientScoping: Interceptor = (next) => (req) => scope.run(`client:${req.header.get("x-tag") ?? "none"}`, () => next(req));

const routes = defineService(StreamingService, {
    echo: async (req) => create(ItemSchema, { value: req.value }),
    client: async (requests) => {
        let total = 0;
        for await (const _item of requests) {
            total++;
            await sleep(1);
        }
        return { total };
    },
    server: async function* (req) {
        yield create(ItemSchema, { value: req.value });
    },
    bidi: async function* (requests) {
        for await (const item of requests) {
            await sleep(1);
            yield create(ItemSchema, { value: item.value, sequence: item.sequence });
        }
    },
});

const started: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

/** Every phase of the producer records the value it runs under: before each yield, after each await, in finally. */
async function* producer(tag: string, seen: Array<string | undefined>) {
    try {
        for (let i = 0; i < MESSAGES; i++) {
            seen.push(scope.getStore());
            yield create(ItemSchema, { value: tag, sequence: i });
            await sleep(1);
            seen.push(scope.getStore());
        }
    } finally {
        seen.push(scope.getStore());
    }
}

type Setup = "local" | "local-client-interceptor" | "http" | "http-client-interceptor";

function clientFor(server: ReturnType<typeof createServer>, setup: Setup) {
    switch (setup) {
        case "local":
            return server.localClient(StreamingService);
        case "local-client-interceptor":
            return createClient(StreamingService, createLocalTransport(server, { interceptors: [clientScoping] }));
        case "http":
            return createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }));
        case "http-client-interceptor":
            return createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}`, interceptors: [clientScoping] }));
    }
}

/** The value the producer must see: the call site's own, or the innermost client-side interceptor's. */
function expectedFor(setup: Setup, tag: string): string {
    return setup.endsWith("client-interceptor") ? `client:${tag}` : `caller:${tag}`;
}

for (const setup of ["local", "local-client-interceptor", "http", "http-client-interceptor"] as const) {
    for (const kind of ["client", "bidi"] as const) {
        describe(`${setup} ${kind}: request producer context`, () => {
            it(`runs every step of the caller's generator in the caller's context, for ${PAIRS} overlapping pairs`, { timeout: 60_000 }, async () => {
                const server = createServer({ services: [routes], port: 0, allowHTTP1: false, interceptors: [serverScoping], shutdown: { timeout: 1_000 } });
                started.push(server);
                await server.start();
                const client = clientFor(server, setup);

                const violations: string[] = [];
                let steps = 0;
                const call = async (tag: string) => {
                    const seen: Array<string | undefined> = [];
                    const callerValue = `caller:${tag}`;
                    await scope.run(callerValue, async () => {
                        const headers = { "x-tag": tag };
                        if (kind === "client") {
                            const count = await client.client(producer(tag, seen), { headers });
                            assert.strictEqual(count.total, MESSAGES);
                        } else {
                            let received = 0;
                            for await (const _item of client.bidi(producer(tag, seen), { headers })) {
                                received++;
                            }
                            assert.strictEqual(received, MESSAGES);
                        }
                        assert.strictEqual(scope.getStore(), callerValue, "the caller keeps its own value after the call");
                    });
                    assert.strictEqual(seen.length, MESSAGES * 2 + 1, "every producer phase ran");
                    const expected = expectedFor(setup, tag);
                    for (const value of seen) {
                        steps++;
                        if (value !== expected) {
                            violations.push(`${tag}: producer saw ${String(value)} instead of ${expected}`);
                        }
                    }
                };

                for (let i = 0; i < PAIRS; i++) {
                    await Promise.all([call(`${kind}-${i}-A`), call(`${kind}-${i}-B`)]);
                }
                assert.strictEqual(steps, PAIRS * 2 * (MESSAGES * 2 + 1));
                assert.deepStrictEqual(violations, [], `${violations.length} of ${steps} producer steps ran under a foreign value`);
            });
        });
    }
}
