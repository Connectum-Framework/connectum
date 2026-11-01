/**
 * In-process streaming calls made once `server.stop()` has begun.
 *
 * A server-streaming or bidirectional call made inside a shutdown hook, or
 * after `stop()` returned, used to finish with zero messages and no error
 * without running the handler, so a shutdown hook reading through the
 * in-process client took the empty list for a real answer. Such a call cannot
 * be served: it has to fail with `unavailable`, and the handler body must not
 * start. Unary and client-streaming calls keep running with the aborted signal.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "../../src/defineService.ts";
import { createLocalTransport } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const started: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

/** What a handler body did, so a test can tell "never started" from "ran and returned nothing". */
interface Bodies {
    server: number;
    bidi: number;
}

function makeServer(bodies: Bodies) {
    const routes = defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        server: async function* () {
            bodies.server++;
            for (let i = 0; i < 3; i++) {
                yield create(ItemSchema, { value: `item-${i}`, sequence: i });
            }
        },
        client: async (requests, ctx) => {
            let total = 0;
            for await (const _item of requests) {
                total++;
            }
            return create(CountSchema, { total: ctx.signal.aborted ? total : -1 });
        },
        bidi: async function* (requests) {
            bodies.bidi++;
            for await (const item of requests) {
                yield create(ItemSchema, { value: `echo:${item.value}`, sequence: item.sequence });
            }
        },
    });
    // allowHTTP1: false because the service mounts a bidi method.
    const server = createServer({ services: [routes], port: 0, allowHTTP1: false, shutdown: { timeout: 1_000 } });
    started.push(server);
    return server;
}

type Outcome = { messages: number[]; error: ConnectError | null };

async function drain(stream: AsyncIterable<{ sequence: number }>): Promise<Outcome> {
    const messages: number[] = [];
    try {
        for await (const item of stream) {
            messages.push(item.sequence);
        }
    } catch (error) {
        return { messages, error: ConnectError.from(error) };
    }
    return { messages, error: null };
}

const twoRequests = () =>
    (async function* () {
        yield create(ItemSchema, { value: "a", sequence: 0 });
        yield create(ItemSchema, { value: "b", sequence: 1 });
    })();

describe("an in-process streaming call made once server.stop() has begun", () => {
    it("fails a server-streaming call inside a shutdown hook with unavailable, without starting the handler", async () => {
        const bodies: Bodies = { server: 0, bidi: 0 };
        const server = makeServer(bodies);
        await server.start();
        let seen: Outcome | undefined;
        server.onShutdown("flush", async () => {
            seen = await drain(server.localClient(StreamingService).server(create(ItemSchema, { value: "x" })));
        });
        await server.stop();

        assert.ok(seen, "the shutdown hook must have run");
        assert.strictEqual(seen.error?.code, Code.Unavailable);
        assert.deepStrictEqual(seen.messages, []);
        assert.strictEqual(bodies.server, 0, "the handler body must not start for a call that cannot be served");
    });

    it("fails a bidirectional call inside a shutdown hook with unavailable, without starting the handler", async () => {
        const bodies: Bodies = { server: 0, bidi: 0 };
        const server = makeServer(bodies);
        await server.start();
        let seen: Outcome | undefined;
        server.onShutdown("flush", async () => {
            seen = await drain(server.localClient(StreamingService).bidi(twoRequests()));
        });
        await server.stop();

        assert.ok(seen, "the shutdown hook must have run");
        assert.strictEqual(seen.error?.code, Code.Unavailable);
        assert.deepStrictEqual(seen.messages, []);
        assert.strictEqual(bodies.bidi, 0);
    });

    for (const entry of ["localClient", "client", "createLocalTransport"] as const) {
        for (const method of ["server", "bidi"] as const) {
            it(`fails a ${method} call made through ${entry} after stop() returned with unavailable`, async () => {
                const bodies: Bodies = { server: 0, bidi: 0 };
                const server = makeServer(bodies);
                await server.start();
                await server.stop();

                const client = entry === "localClient" ? server.localClient(StreamingService) : entry === "client" ? server.client(StreamingService) : createClient(StreamingService, createLocalTransport(server));
                const seen = await drain(method === "server" ? client.server(create(ItemSchema, { value: "x" })) : client.bidi(twoRequests()));

                assert.strictEqual(seen.error?.code, Code.Unavailable);
                assert.deepStrictEqual(seen.messages, []);
                assert.strictEqual(bodies[method], 0);
            });
        }
    }

    it("still serves a unary call, which runs with the aborted signal", async () => {
        const bodies: Bodies = { server: 0, bidi: 0 };
        const server = makeServer(bodies);
        await server.start();
        await server.stop();
        const res = await server.localClient(StreamingService).echo(create(ItemSchema, { value: "u", sequence: 7 }));
        assert.strictEqual(res.value, "u");
    });

    it("still serves a client-streaming call: the handler runs, reads the whole input and sees the aborted signal", async () => {
        const bodies: Bodies = { server: 0, bidi: 0 };
        const server = makeServer(bodies);
        await server.start();
        await server.stop();
        const res = await server.localClient(StreamingService).client(twoRequests());
        assert.strictEqual(res.total, 2);
    });
});
