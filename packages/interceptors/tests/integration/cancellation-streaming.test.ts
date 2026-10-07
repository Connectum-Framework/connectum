/**
 * Cancellation at a real RPC stream's opening boundary. Response transforms
 * keep each stream shape open after its first message, including the single
 * response of a client-streaming RPC. This separates middleware completion
 * from later iterator work without depending on transport buffering speed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { CountSchema, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createRetryInterceptor } from "../../src/retry.ts";
import { createTimeoutInterceptor } from "../../src/timeout.ts";

type StreamKind = "server" | "client" | "bidi";
type Placement = "server" | "client";
type TransportKind = "local" | "http";

function deferred() {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, resolve: () => resolve() };
}

async function* input() {
    yield create(ItemSchema, { value: "payload", sequence: 7 });
}

function invoke(transport: Transport, kind: StreamKind, signal: AbortSignal) {
    switch (kind) {
        case "server":
            return transport.stream(StreamingService.method.server, signal, undefined, {}, input());
        case "client":
            return transport.stream(StreamingService.method.client, signal, undefined, {}, input());
        case "bidi":
            return transport.stream(StreamingService.method.bidi, signal, undefined, {}, input());
    }
}

/** Assert the proto-defined response fields, independent of generated clients. */
function assertMessage(kind: StreamKind, message: unknown) {
    assert.equal(typeof message, "object");
    assert.ok(message !== null);
    if (kind === "client") {
        assert.deepEqual(message, { $typeName: "streaming.v1.Count", total: 1 });
    } else {
        assert.deepEqual(message, { $typeName: "streaming.v1.Item", value: "payload", sequence: 7 });
    }
}

function isError(code: Code, rawMessage?: string) {
    return (error: unknown) => {
        assert.ok(error instanceof ConnectError);
        assert.equal(error.code, code);
        if (rawMessage !== undefined) assert.equal(error.rawMessage, rawMessage);
        assert.deepEqual(error.details, []);
        return true;
    };
}

async function withRpc(transportKind: TransportKind, placement: Placement, interceptors: Interceptor[], run: (transport: Transport) => Promise<void>) {
    const server = createServer({
        host: "127.0.0.1",
        port: 0,
        allowHTTP1: false,
        shutdown: { autoShutdown: false, timeout: 100 },
        interceptors: placement === "server" ? interceptors : [],
        services: [
            defineService(StreamingService, {
                echo: (req) => req,
                async *server(req) {
                    yield req;
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
    let session: Http2SessionManager | undefined;
    try {
        let transport: Transport;
        if (transportKind === "http") {
            await server.start();
            const port = server.address?.port;
            assert.ok(port);
            const baseUrl = `http://127.0.0.1:${port}`;
            session = new Http2SessionManager(baseUrl);
            transport = createGrpcTransport({ baseUrl, sessionManager: session, interceptors: placement === "client" ? interceptors : [] });
        } else {
            transport = createLocalTransport(server, { interceptors: placement === "client" ? interceptors : [] });
        }
        await run(transport);
    } finally {
        session?.abort();
        if (server.isRunning) await server.stop();
    }
}

for (const transportKind of ["local", "http"] as const) {
    for (const placement of ["server", "client"] as const) {
        for (const kind of ["server", "client", "bidi"] as const) {
            describe(`${transportKind} ${placement}-side ${kind}-stream cancellation`, { timeout: 10_000 }, () => {
                it("default timeout bypass permits slow opening without changing its signal", async () => {
                    let incoming: AbortSignal | undefined;
                    let downstream: AbortSignal | undefined;
                    const capture: Interceptor = (next) => async (req) => {
                        incoming = req.signal;
                        return next(req);
                    };
                    const slowOpening: Interceptor = (next) => async (req) => {
                        downstream = req.signal;
                        await sleep(40);
                        assert.equal(req.signal.aborted, false);
                        return next(req);
                    };
                    await withRpc(transportKind, placement, [capture, createTimeoutInterceptor({ duration: 10 }), slowOpening], async (transport) => {
                        const response = await invoke(transport, kind, new AbortController().signal);
                        const received: unknown[] = [];
                        for await (const message of response.message) received.push(message);
                        assert.equal(received.length, 1);
                        assertMessage(kind, received[0]);
                        assert.strictEqual(downstream, incoming);
                    });
                });

                it("default retry bypass returns the opening failure without another attempt", async () => {
                    let attempts = 0;
                    const failOpening: Interceptor = () => async () => {
                        attempts++;
                        throw new ConnectError("opening unavailable", Code.Unavailable);
                    };
                    await withRpc(transportKind, placement, [createRetryInterceptor({ initialDelay: 0 }), failOpening], async (transport) => {
                        // Some transports defer the server chain until iteration.
                        await assert.rejects(
                            async () => {
                                const response = await invoke(transport, kind, new AbortController().signal);
                                for await (const _ of response.message) {
                                }
                            },
                            isError(Code.Unavailable, "opening unavailable"),
                        );
                        assert.equal(attempts, 1);
                    });
                });

                it("opt-in timeout aborts downstream while opening and reports its own deadline", async () => {
                    let downstream: AbortSignal | undefined;
                    let cleanup = 0;
                    const cancelled = deferred();
                    const waitOpening: Interceptor = (next) => async (req) => {
                        downstream = req.signal;
                        try {
                            await sleep(5_000, undefined, { signal: req.signal });
                            return await next(req);
                        } finally {
                            cleanup++;
                            cancelled.resolve();
                        }
                    };
                    await withRpc(transportKind, placement, [createTimeoutInterceptor({ duration: 40, skipStreaming: false }), waitOpening], async (transport) => {
                        await assert.rejects(
                            async () => {
                                const response = await invoke(transport, kind, new AbortController().signal);
                                for await (const _ of response.message) {
                                }
                            },
                            isError(Code.DeadlineExceeded, "Request timeout after 40ms"),
                        );
                        await cancelled.promise;
                        assert.equal(downstream?.aborted, true);
                        assert.ok(downstream?.reason instanceof ConnectError);
                        assert.equal(downstream.reason.code, Code.DeadlineExceeded);
                        assert.equal(cleanup, 1);
                    });
                });

                it("opt-in retry repeats a failed opener and returns the exact successful response", async () => {
                    let attempts = 0;
                    const transient: Interceptor = (next) => async (req) => {
                        if (++attempts === 1) throw new ConnectError("transient opening", Code.Unavailable);
                        return next(req);
                    };
                    await withRpc(transportKind, placement, [createRetryInterceptor({ initialDelay: 0, maxDelay: 0, skipStreaming: false }), transient], async (transport) => {
                        const response = await invoke(transport, kind, new AbortController().signal);
                        const received: unknown[] = [];
                        for await (const message of response.message) received.push(message);
                        assert.equal(received.length, 1);
                        assertMessage(kind, received[0]);
                        assert.equal(attempts, 2);
                    });
                });

                it("response consumption succeeds after the successful opener's timeout duration", async () => {
                    let cleanup = 0;
                    const delayConsumption: Interceptor = (next) => async (req) => {
                        const response = await next(req);
                        assert.ok(response.stream);
                        const original = response.message;
                        return {
                            ...response,
                            message: (async function* () {
                                try {
                                    // Read the body promptly, then delay delivery to the
                                    // consumer so the assertion isolates opener lifetime
                                    // from application processing of an available message.
                                    for await (const message of original) {
                                        await sleep(80);
                                        assert.equal(req.signal.aborted, false, "the opener timer must be cleared before response consumption");
                                        yield message;
                                    }
                                } finally {
                                    cleanup++;
                                }
                            })(),
                        };
                    };
                    await withRpc(transportKind, placement, [createTimeoutInterceptor({ duration: 40, skipStreaming: false }), delayConsumption], async (transport) => {
                        const response = await invoke(transport, kind, new AbortController().signal);
                        const received: unknown[] = [];
                        for await (const message of response.message) received.push(message);
                        assert.equal(received.length, 1);
                        assertMessage(kind, received[0]);
                        assert.equal(cleanup, 1);
                    });
                });

                it("successful opening outlives the timer and still forwards later caller cancellation", async () => {
                    const caller = new AbortController();
                    const opened = deferred();
                    const finished = deferred();
                    const release = deferred();
                    let downstream: AbortSignal | undefined;
                    let cleanup = 0;
                    const holdResponse: Interceptor = (next) => async (req) => {
                        downstream = req.signal;
                        const response = await next(req);
                        assert.ok(response.stream);
                        assert.equal(req.signal.aborted, false, "successful opener must not abort its downstream signal");
                        const original = response.message;
                        return {
                            ...response,
                            message: (async function* () {
                                try {
                                    for await (const message of original) {
                                        yield message;
                                        opened.resolve();
                                        await sleep(5_000, undefined, { signal: req.signal });
                                        await release.promise;
                                    }
                                } finally {
                                    cleanup++;
                                    finished.resolve();
                                }
                            })(),
                        };
                    };
                    try {
                        await withRpc(transportKind, placement, [createTimeoutInterceptor({ duration: 40, skipStreaming: false }), holdResponse], async (transport) => {
                            const response = await invoke(transport, kind, caller.signal);
                            const iterator = response.message[Symbol.asyncIterator]();
                            const first = await iterator.next();
                            assert.equal(first.done, false);
                            assertMessage(kind, first.value);
                            const rejected = assert.rejects(iterator.next(), isError(Code.Canceled));
                            await opened.promise;
                            await sleep(80);
                            assert.equal(downstream?.aborted, false, "the expired opening timer must not cancel the response iterator");
                            assert.equal(cleanup, 0);
                            caller.abort(new ConnectError("caller stopped opened stream", Code.Canceled));
                            await rejected;
                            await finished.promise;
                            assert.equal(downstream?.aborted, true);
                            assert.equal(cleanup, 1);
                        });
                    } finally {
                        caller.abort();
                        release.resolve();
                    }
                });

                it("a response iterator failure does not restart the already successful opener", async () => {
                    let attempts = 0;
                    let cleanup = 0;
                    const failIterator: Interceptor = (next) => async (req) => {
                        attempts++;
                        const response = await next(req);
                        assert.ok(response.stream);
                        const original = response.message;
                        return {
                            ...response,
                            message: (async function* () {
                                try {
                                    for await (const message of original) yield message;
                                    throw new ConnectError("response iterator unavailable", Code.Unavailable);
                                } finally {
                                    cleanup++;
                                }
                            })(),
                        };
                    };
                    await withRpc(transportKind, placement, [createRetryInterceptor({ initialDelay: 0, skipStreaming: false }), failIterator], async (transport) => {
                        const received: unknown[] = [];
                        await assert.rejects(
                            async () => {
                                const response = await invoke(transport, kind, new AbortController().signal);
                                for await (const message of response.message) received.push(message);
                            },
                            isError(Code.Unavailable, "response iterator unavailable"),
                        );
                        assert.equal(received.length, 1);
                        assertMessage(kind, received[0]);
                        assert.equal(attempts, 1);
                        assert.equal(cleanup, 1);
                    });
                });
            });
        }
    }
}
