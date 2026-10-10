/**
 * Catalog client-streaming: `close()` must observe the call's complete outcome.
 *
 * A client-streaming RPC has exactly one response followed by a terminal
 * status. The reference semantics (`createClientStreamingFn` in
 * `@connectrpc/connect`) drain the response iterable to its end, require
 * exactly one message and only then resolve. These tests drive the shared
 * client-stream opener through BOTH catalog surfaces (`createCatalogClient`
 * and the handler `ctx.stream` with a remote route) over TWO transports whose
 * response sequence the test controls message by message:
 *
 *  - an in-memory scripted transport, where the test can also observe whether
 *    the response stream was driven to its end (which is what lets a wrapping
 *    interceptor's generator `finally` run);
 *  - a real gRPC-over-HTTP/2 server on a loopback port that frames the same
 *    script on the wire (message frames, then `grpc-status` trailers).
 *
 * A conformant handler cannot be asked to produce "response, then failure",
 * "extra response" or "late trailers", so a scripted server is the only way to
 * reach those terminal outcomes.
 */

import assert from "node:assert";
import { createServer as createHttp2Server, type Http2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type StreamResponse, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createCatalogClient } from "../../src/catalogClient.ts";
import type { CallOptions, ClientStreamHandle } from "../../src/context.ts";
import { defineService } from "../../src/defineService.ts";
import { singleTransportResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Count, CountSchema, type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: Item; response: Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: Item; response: Item; kind: "bidi" };
    }
}

const CLIENT_STREAM = "streaming.v1.StreamingService/Client" as const;

const catalog = defineCatalog({
    [StreamingService.typeName]: StreamingService,
    [EchoService.typeName]: EchoService,
});

/** What the scripted peer observed about the response stream it served. */
interface Probe {
    /** The response generator ran past its last statement (the stream reached its end). */
    reachedEnd: boolean;
    /** The response generator's `finally` ran, for any reason (end, error or early return). */
    finalized: boolean;
    /**
     * Aborted when the call is canceled: the caller's signal for the in-memory
     * transport, the closing of the HTTP/2 stream for the wire server.
     */
    signal: AbortSignal | undefined;
}

type Script = (probe: Probe) => AsyncGenerator<Count>;

function count(total: number): Count {
    return create(CountSchema, { total });
}

function newProbe(): Probe {
    return { reachedEnd: false, finalized: false, signal: undefined };
}

/** Runs `script` with the probe bookkeeping every harness shares. */
async function* runScript(script: Script, probe: Probe): AsyncGenerator<Count> {
    try {
        yield* script(probe);
        probe.reachedEnd = true;
    } finally {
        probe.finalized = true;
    }
}

/** A way of serving a {@link Script} to the code under test over some transport. */
interface Harness {
    readonly name: string;
    /**
     * Whether `probe.reachedEnd` reflects what the CLIENT did. True only when
     * the script runs inside the client's own response iterable; on the wire the
     * server finishes its script regardless of how the client reads.
     */
    readonly probeTracksClient: boolean;
    /**
     * Whether the transport enforces a call's `timeoutMs` itself. A deadline is the transport's job, as with a
     * standard Connect client; the scripted transport below ignores it, so a deadline is only observable on the wire.
     */
    readonly enforcesDeadline: boolean;
    serve<T>(script: Script, probe: Probe, use: (transport: Transport) => Promise<T>): Promise<T>;
}

const inMemory: Harness = {
    name: "in-memory transport",
    probeTracksClient: true,
    enforcesDeadline: false,
    async serve(script, probe, use) {
        const transport: Transport = {
            unary: () => {
                throw new Error("the scripted transport serves client-streaming only");
            },
            stream: async (method, signal) => {
                probe.signal = signal;
                return {
                    stream: true,
                    service: method.parent,
                    method,
                    header: new Headers(),
                    trailer: new Headers(),
                    message: runScript(script, probe),
                } as unknown as StreamResponse<never, never>;
            },
        };
        return use(transport);
    },
};

/** One gRPC length-prefixed message frame. */
function grpcFrame(message: Count): Buffer {
    const payload = toBinary(CountSchema, message);
    const frame = Buffer.alloc(5 + payload.length);
    frame.writeUInt32BE(payload.length, 1);
    frame.set(payload, 5);
    return frame;
}

const wire: Harness = {
    name: "gRPC over HTTP/2 on loopback",
    probeTracksClient: false,
    enforcesDeadline: true,
    async serve(script, probe, use) {
        const http2: Http2Server = createHttp2Server();
        const sessions = new Set<ServerHttp2Session>();
        http2.on("session", (session) => {
            sessions.add(session);
            session.on("close", () => sessions.delete(session));
        });
        http2.on("stream", (stream: ServerHttp2Stream) => {
            const canceled = new AbortController();
            probe.signal = canceled.signal;
            stream.on("close", () => canceled.abort());
            stream.resume();
            stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
            let trailers: Record<string, string> = { "grpc-status": "0" };
            stream.on("wantTrailers", () => stream.sendTrailers(trailers));
            void (async () => {
                try {
                    for await (const message of runScript(script, probe)) {
                        stream.write(grpcFrame(message));
                    }
                } catch (error) {
                    const failure = ConnectError.from(error);
                    trailers = { "grpc-status": String(failure.code), "grpc-message": encodeURIComponent(failure.rawMessage) };
                }
                if (!stream.closed && !stream.destroyed) stream.end();
            })();
        });
        await new Promise<void>((resolve) => http2.listen(0, "127.0.0.1", resolve));
        const { port } = http2.address() as AddressInfo;
        try {
            return await use(createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` }));
        } finally {
            for (const session of sessions) session.destroy();
            await new Promise<void>((resolve) => http2.close(() => resolve()));
        }
    },
};

interface Gate {
    readonly open: () => void;
    readonly opened: Promise<void>;
}

function gate(): Gate {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, opened };
}

/** Lets already-queued microtasks and I/O callbacks run before the caller inspects state. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

type OpenHandle = (options?: CallOptions) => ClientStreamHandle<Item, Count>;

interface Surface {
    readonly name: string;
    /** Run `body` with an opener that reaches `transport` through this surface. */
    run<T>(transport: Transport, body: (open: OpenHandle) => Promise<T>): Promise<T>;
}

const standalone: Surface = {
    name: "createCatalogClient",
    async run(transport, body) {
        const client = createCatalogClient({ catalog, resolver: singleTransportResolver(transport) });
        return body((options) => client.stream(CLIENT_STREAM)(options));
    },
};

const handlerStream: Surface = {
    name: "ctx.stream (remote route)",
    async run<T>(transport: Transport, body: (open: OpenHandle) => Promise<T>) {
        let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
        const server = createServer({
            services: [
                defineService(EchoService, {
                    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    async secureEcho(_req, ctx) {
                        try {
                            outcome = { ok: true, value: await body((options) => ctx.stream(CLIENT_STREAM)(options)) };
                        } catch (error) {
                            outcome = { ok: false, error };
                        }
                        return create(EchoResponseSchema, { message: "done", timestamp: 0n });
                    },
                }),
            ],
            catalog,
            remoteResolver: ({ typeName }) => (typeName === StreamingService.typeName ? transport : null),
        });
        await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }));
        assert.ok(outcome !== undefined, "the handler must have run the body");
        if (!outcome.ok) throw outcome.error;
        return outcome.value as T;
    },
};

function send(handle: ClientStreamHandle<Item, Count>): void {
    handle.send(create(ItemSchema, { value: "a", sequence: 0 }));
}

for (const harness of [inMemory, wire]) {
    for (const surface of [standalone, handlerStream]) {
        /** Serve `script`, reach it through `surface`, and run `body`. */
        function runCase<T>(script: Script, probe: Probe, body: (open: OpenHandle) => Promise<T>): Promise<T> {
            return harness.serve(script, probe, (transport) => surface.run(transport, body));
        }

        describe(`client-stream terminal outcome — ${surface.name} over ${harness.name}`, () => {
            it("resolves the single response", async () => {
                const probe = newProbe();
                const res = await runCase(
                    async function* () {
                        yield count(1);
                    },
                    probe,
                    async (open) => {
                        const handle = open();
                        send(handle);
                        return handle.close();
                    },
                );
                assert.strictEqual(res.total, 1);
                if (harness.probeTracksClient) {
                    assert.strictEqual(probe.reachedEnd, true, "close() resolved before the response stream was driven to its end");
                    assert.strictEqual(probe.finalized, true);
                }
            });

            it("does not resolve while the terminal status is still pending (late trailers)", async () => {
                const probe = newProbe();
                const trailers = gate();
                await runCase(
                    async function* () {
                        yield count(7);
                        await trailers.opened;
                    },
                    probe,
                    async (open) => {
                        const handle = open();
                        send(handle);
                        let settled = false;
                        const closing = handle.close().then(
                            (value) => {
                                settled = true;
                                return value;
                            },
                            (error: unknown) => {
                                settled = true;
                                throw error;
                            },
                        );
                        await settle();
                        assert.strictEqual(settled, false, "close() settled although the terminal status had not arrived");
                        trailers.open();
                        const res = await closing;
                        assert.strictEqual(res.total, 7);
                    },
                );
            });

            it("rejects when the stream ends without any response", async () => {
                const probe = newProbe();
                await runCase(
                    async function* () {
                        // no response message
                    },
                    probe,
                    async (open) => {
                        const handle = open();
                        send(handle);
                        await assert.rejects(
                            () => handle.close(),
                            (err: unknown) => err instanceof ConnectError && err.code === Code.Internal && /no response/.test(err.rawMessage),
                        );
                    },
                );
            });

            it("rejects on an extra response, after the stream has been driven to its end", async () => {
                const probe = newProbe();
                await runCase(
                    async function* () {
                        yield count(1);
                        yield count(2);
                    },
                    probe,
                    async (open) => {
                        const handle = open();
                        send(handle);
                        await assert.rejects(
                            () => handle.close(),
                            (err: unknown) => err instanceof ConnectError && err.code === Code.Internal && /more than one response/.test(err.rawMessage),
                        );
                    },
                );
                if (harness.probeTracksClient) {
                    assert.strictEqual(probe.reachedEnd, true, "the extra-response check must not abandon the stream before its end");
                }
            });

            it("rejects with the terminal failure that follows a response", async () => {
                const probe = newProbe();
                await runCase(
                    async function* () {
                        yield count(1);
                        throw new ConnectError("late failure", Code.DataLoss);
                    },
                    probe,
                    async (open) => {
                        const handle = open();
                        send(handle);
                        await assert.rejects(
                            () => handle.close(),
                            (err: unknown) => err instanceof ConnectError && err.code === Code.DataLoss && err.rawMessage === "late failure",
                        );
                    },
                );
            });

            it("rejects as canceled when the caller aborts after the response but before the terminal status", async () => {
                const probe = newProbe();
                await runCase(
                    async function* (p) {
                        yield count(1);
                        const signal = p.signal;
                        assert.ok(signal !== undefined, "the peer must be able to observe cancellation");
                        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                        throw new ConnectError("canceled", Code.Canceled);
                    },
                    probe,
                    async (open) => {
                        const controller = new AbortController();
                        const handle = open({ signal: controller.signal });
                        send(handle);
                        const assertion = assert.rejects(
                            () => handle.close(),
                            (err: unknown) => err instanceof ConnectError && err.code === Code.Canceled,
                        );
                        await settle();
                        controller.abort();
                        await assertion;
                    },
                );
                await settle();
                assert.strictEqual(probe.finalized, true, "the peer's response stream must be finalized after cancellation");
            });

            it("releases close() with DeadlineExceeded when the terminal status does not arrive within timeoutMs", { skip: harness.enforcesDeadline ? false : "the scripted transport does not enforce deadlines" }, async () => {
                const probe = newProbe();
                await runCase(
                    async function* (p) {
                        yield count(1);
                        // The status never arrives on its own: only the call's deadline can end the wait. The
                        // fallback timer keeps a transport that does not forward the abort from hanging the suite.
                        await new Promise<void>((resolve) => {
                            const fallback = setTimeout(resolve, 5_000);
                            p.signal?.addEventListener(
                                "abort",
                                () => {
                                    clearTimeout(fallback);
                                    resolve();
                                },
                                { once: true },
                            );
                        });
                        throw new ConnectError("peer released", Code.Canceled);
                    },
                    probe,
                    async (open) => {
                        const handle = open({ timeoutMs: 300 });
                        send(handle);
                        const startedAt = Date.now();
                        await assert.rejects(
                            () => handle.close(),
                            (err: unknown) => err instanceof ConnectError && err.code === Code.DeadlineExceeded,
                        );
                        assert.ok(Date.now() - startedAt < 3_000, "close() must be released by the deadline, not by the peer's own timer");
                    },
                );
            });
        });
    }
}
