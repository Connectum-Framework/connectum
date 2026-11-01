/**
 * A client-streaming or bidirectional handler waiting for the next request
 * message is released when the caller cancels the call.
 *
 * Over HTTP/2 a cancelled call closes the request body, so the handler's
 * `for await` over the requests ends and its `finally` runs. In-process the
 * handler reads the caller's own iterable and nothing closed it: the handler
 * stayed suspended and its `finally` never ran. `server.stop()` is different: it
 * does not end an in-process call, so an upload that is still being sent keeps
 * being read, exactly as it is over HTTP/2.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
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

/** A client-streaming or bidirectional handler that reads the requests and records what it saw. */
function makeReader() {
    const state = { phase: "not started", requestLoop: "running" as "running" | "ended" | "threw", received: 0, finallyRuns: 0 };
    async function read(requests: AsyncIterable<unknown>): Promise<void> {
        state.phase = "waiting for requests";
        try {
            for await (const _item of requests) {
                state.received++;
            }
            state.requestLoop = "ended";
        } catch (error) {
            state.requestLoop = "threw";
            throw error;
        } finally {
            state.finallyRuns++;
            state.phase = "finished";
        }
    }
    const routes = defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        server: async function* () {},
        client: async (requests) => {
            await read(requests);
            return create(CountSchema, { total: state.received });
        },
        bidi: async function* (requests) {
            await read(requests);
        },
    });
    return { routes, state };
}

/** A request stream that stays open and empty until the caller's return() releases it. */
function silentRequests() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const requests = (async function* () {
        await gate;
    })();
    return { requests, release };
}

type Kind = "http" | "local";

async function connect(kind: Kind, routes: ReturnType<typeof makeReader>["routes"]) {
    const server = createServer({ services: [routes], port: 0, allowHTTP1: false, shutdown: { timeout: 3_000 } });
    started.push(server);
    await server.start();
    const client = kind === "http" ? createClient(StreamingService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` })) : server.localClient(StreamingService);
    return { server, client };
}

for (const kind of ["http", "local"] as const) {
    for (const method of ["client", "bidi"] as const) {
        describe(`cancelling a ${method}-streaming call whose handler waits for requests, over ${kind}`, () => {
            const call = (client: Awaited<ReturnType<typeof connect>>["client"], requests: ReturnType<typeof silentRequests>["requests"], signal: AbortSignal) =>
                method === "client" ? client.client(requests, { signal }) : drain(client.bidi(requests, { signal }));

            it("releases the handler's request loop and runs its finally when the caller aborts", async () => {
                const { routes, state } = makeReader();
                const { client } = await connect(kind, routes);
                const abort = new AbortController();
                const { requests, release } = silentRequests();
                try {
                    const settled = call(client, requests, abort.signal).then(
                        (value) => ({ value }),
                        (error: unknown) => ({ error: ConnectError.from(error) }),
                    );
                    for (let waited = 0; state.phase !== "waiting for requests" && waited < 2_000; waited += 10) {
                        await sleep(10);
                    }
                    assert.strictEqual(state.phase, "waiting for requests", "the handler must be parked on the request stream");
                    abort.abort();
                    const outcome = await settled;
                    // client-streaming rejects the call; bidi surfaces the error through the drained outcome
                    const code = "error" in outcome ? outcome.error.code : (outcome.value as Outcome).error?.code;
                    assert.strictEqual(code, Code.Canceled);

                    await sleep(500);
                    assert.strictEqual(state.phase, "finished", "the handler must be released, not left waiting");
                    assert.strictEqual(state.finallyRuns, 1);
                    assert.strictEqual(state.requestLoop, "ended", "the request loop ends the way it does over HTTP/2");
                } finally {
                    release();
                }
            });

            it("releases the handler when the call hits its deadline", async () => {
                const { routes, state } = makeReader();
                const { client } = await connect(kind, routes);
                const { requests, release } = silentRequests();
                try {
                    const outcome = await (method === "client" ? client.client(requests, { timeoutMs: 150 }) : drain(client.bidi(requests, { timeoutMs: 150 }))).then(
                        (value) => ({ value }),
                        (error: unknown) => ({ error: ConnectError.from(error) }),
                    );
                    const code = "error" in outcome ? outcome.error.code : (outcome.value as Outcome).error?.code;
                    assert.strictEqual(code, Code.DeadlineExceeded);
                    await sleep(500);
                    assert.strictEqual(state.phase, "finished");
                    assert.strictEqual(state.finallyRuns, 1);
                } finally {
                    release();
                }
            });
        });
    }
}

// An upload that is still being sent when `stop()` runs. HTTP/2 lets an in-flight stream finish within the
// shutdown timeout, and an in-process call is never ended by `stop()`, so the handler must read every message
// and the call must complete with its answer on both transports.
for (const kind of ["http", "local"] as const) {
    describe(`server.stop() during a client-streaming upload, over ${kind}`, () => {
        it("lets the upload finish and delivers the handler's answer", async () => {
            const { routes, state } = makeReader();
            const { server, client } = await connect(kind, routes);
            const upload = (async function* () {
                for (let i = 0; i < 12; i++) {
                    yield create(ItemSchema, { value: `m${i}`, sequence: i });
                    await sleep(40);
                }
            })();
            const result = client.client(upload);
            await sleep(150);
            await server.stop();
            const res = await result;
            assert.strictEqual(res.total, 12, "no message of the upload is lost");
            assert.strictEqual(state.requestLoop, "ended");
        });
    });
}
