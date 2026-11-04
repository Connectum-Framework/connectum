/**
 * `server.stop()` while a server stream is still sending.
 *
 * A stream the server has to cut must not end like a complete response: a
 * client that is told "OK" cannot tell a truncated list from a full one and can
 * lose data silently. Over a real socket, with the Connect protocol and the
 * gRPC protocol, and in-process, the handler below ignores `ctx.signal` and
 * wants to send ten items. `stop()` arrives after three. The oracle is what the
 * client observes: the items sent before the stop arrive in order, and the
 * stream then fails with `unavailable`.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const ITEMS = 10;
const STOP_AFTER = 3;

type Behaviour = "ignores-signal" | "returns-when-aborted";

/**
 * A server stream that sends `ITEMS` items, 40 ms apart.
 * `onSent` fires after each item is handed to the transport.
 */
function makeRoutes(behaviour: Behaviour, onSent: (sent: number) => void) {
    async function* items(signal: AbortSignal) {
        for (let i = 0; i < ITEMS; i++) {
            if (behaviour === "returns-when-aborted" && signal.aborted) {
                return;
            }
            yield create(ItemSchema, { value: `item-${i}`, sequence: i });
            onSent(i + 1);
            await new Promise<void>((resolve) => setTimeout(resolve, 40));
        }
    }
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        server: (_req, ctx) => items(ctx.signal),
        client: async () => create(CountSchema, { total: 0 }),
        // The bidi handler streams its own items and does not read the requests.
        bidi: (_requests, ctx) => items(ctx.signal),
    });
}

type Observed = { received: number[]; error: ConnectError | null };

/** Read the stream to its end, keeping what arrived and how it ended. */
async function drain(stream: AsyncIterable<{ sequence: number }>): Promise<Observed> {
    const received: number[] = [];
    try {
        for await (const item of stream) {
            received.push(item.sequence);
        }
    } catch (err) {
        return { received, error: ConnectError.from(err) };
    }
    return { received, error: null };
}

const KINDS = ["connect", "grpc", "in-process"] as const;

for (const kind of KINDS) {
  for (const method of ["server", "bidi"] as const) {
    describe(`server.stop() cutting a ${method === "server" ? "server stream" : "bidi stream"} (${kind})`, () => {
        async function run(behaviour: Behaviour): Promise<Observed> {
            let stopRequested: () => void = () => {};
            const reachedStopPoint = new Promise<void>((resolve) => {
                stopRequested = resolve;
            });
            const server = createServer({
                services: [
                    makeRoutes(behaviour, (sent) => {
                        if (sent === STOP_AFTER) {
                            stopRequested();
                        }
                    }),
                ],
                port: 0,
                host: "127.0.0.1",
                allowHTTP1: false,
                shutdown: { timeout: 5_000 },
            });
            await server.start();
            const baseUrl = `http://127.0.0.1:${server.address?.port}`;
            const client =
                kind === "in-process"
                    ? server.localClient(StreamingService)
                    : createClient(StreamingService, kind === "grpc" ? createGrpcTransport({ baseUrl }) : createConnectTransport({ baseUrl, httpVersion: "2" }));
            // A bidi caller sends one request and keeps its request stream open until the call is over.
            const requestsDone = Promise.withResolvers<void>();
            async function* requests() {
                yield create(ItemSchema, { value: "x", sequence: 0 });
                await requestsDone.promise;
            }
            const observed = drain(method === "server" ? client.server(create(ItemSchema, { value: "x", sequence: 0 })) : client.bidi(requests()));
            await reachedStopPoint;
            await server.stop();
            const outcome = await observed;
            requestsDone.resolve();
            return outcome;
        }

        it("ends a stream whose handler ignores the signal with unavailable, after the items already sent", async () => {
            const { received, error } = await run("ignores-signal");
            assert.ok(error, `the client must be told the stream was cut, got a normal end after ${received.length} of ${ITEMS} items`);
            assert.strictEqual(error.code, Code.Unavailable, `got ${Code[error.code]}: ${error.rawMessage}`);
            assert.ok(received.length >= STOP_AFTER && received.length < ITEMS, `items that arrived: ${received.length}`);
            assert.deepStrictEqual(
                received,
                Array.from({ length: received.length }, (_, i) => i),
                "the items sent before the stop arrive complete and in order",
            );
        });

        it("keeps a stream that the handler ends by itself after seeing the abort a normal end", async () => {
            // The handler decided to finish: that is its answer, not a cut made by the server.
            const { received, error } = await run("returns-when-aborted");
            assert.strictEqual(error, null);
            assert.ok(received.length >= STOP_AFTER && received.length < ITEMS, `items that arrived: ${received.length}`);
        });
    });
  }
}

describe("a server stream that finishes before stop()", () => {
    it("still ends with a normal end, not unavailable", async () => {
        const server = createServer({
            services: [makeRoutes("ignores-signal", () => {})],
            port: 0,
            host: "127.0.0.1",
            allowHTTP1: false,
        });
        await server.start();
        const client = createClient(
            StreamingService,
            createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` }),
        );
        const { received, error } = await drain(client.server(create(ItemSchema, { value: "x", sequence: 0 })));
        await server.stop();
        assert.strictEqual(error, null);
        assert.strictEqual(received.length, ITEMS);
    });
});
