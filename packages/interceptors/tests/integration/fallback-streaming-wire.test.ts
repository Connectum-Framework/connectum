/**
 * Fallback for a streaming call, through real gRPC and Connect connections.
 *
 * With `skipStreaming: false` the fallback interceptor stands in for a streaming call whose
 * opening failed: the caller must receive the provider's message as the call's only message
 * (the only response of a client-streaming call) instead of the failure. A unit test on the
 * interceptor alone cannot tell whether the shape it returns is one the protocol layer can
 * send: a unary-shaped response for a streaming call reaches the caller as
 * `Internal: internal error` with no message, so each case here runs a real `createServer`
 * (or a real client transport) over HTTP/2 and reads what the caller sees. The oracle is
 * the documented behaviour of the option: recovery from an opening failure only; a refusal
 * of access, a failure after the first message and the default bypass are untouched.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { CountSchema, ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createFallbackInterceptor } from "../../src/fallback.ts";

const FALLBACK_VALUE = "cached-message";

/** Counts the calls of the fallback provider, so a test can tell "replaced" from "never asked". */
interface Provider {
    calls: number;
}

/** A fallback whose provider answers with the message type of the method being called. */
function fallbackFor(provider: Provider, options: { skipStreaming?: boolean }): Interceptor {
    const forItem = createFallbackInterceptor({
        ...options,
        handler: () => {
            provider.calls++;
            return create(ItemSchema, { value: FALLBACK_VALUE, sequence: 1 });
        },
    });
    const forCount = createFallbackInterceptor({
        ...options,
        handler: () => {
            provider.calls++;
            return create(CountSchema, { total: 99 });
        },
    });
    return (next) => (req) => (req.method.name === "Client" ? forCount(next)(req) : forItem(next)(req));
}

/** Fails before any response exists, the way a dependency of the chain failing at the opening does. */
function failOpening(code: Code): Interceptor {
    return () => async () => {
        throw new ConnectError("intentional opening failure", code);
    };
}

/** Lets the call open, then fails after the first message. */
function failAfterFirstMessage(): Interceptor {
    return (next) => async (req) => {
        const response = await next(req);
        if (!response.stream) {
            return response;
        }
        const messages = response.message;
        return {
            ...response,
            message: (async function* () {
                for await (const message of messages) {
                    yield message;
                    throw new ConnectError("failure after the first message", Code.Unavailable);
                }
            })(),
        };
    };
}

function routes() {
    return defineService(StreamingService, {
        echo: (request) => request,
        async *server() {
            yield create(ItemSchema, { value: "normal-first", sequence: 1 });
            yield create(ItemSchema, { value: "normal-second", sequence: 2 });
        },
        async client(requests) {
            let total = 0;
            for await (const _ of requests) {
                total++;
            }
            return create(CountSchema, { total });
        },
        async *bidi(requests) {
            for await (const item of requests) {
                yield item;
            }
        },
    });
}

async function* oneItem() {
    yield create(ItemSchema, { value: "payload", sequence: 7 });
}

type Protocol = "gRPC" | "Connect";

function transportFor(protocol: Protocol, baseUrl: string, session: Http2SessionManager, interceptors: Interceptor[] = []): Transport {
    return protocol === "gRPC"
        ? createGrpcTransport({ baseUrl, sessionManager: session, interceptors })
        : createConnectTransport({ baseUrl, httpVersion: "2", useBinaryFormat: true, sessionManager: session, interceptors });
}

interface Running {
    server: Server;
    baseUrl: string;
    session: Http2SessionManager;
}

async function startServer(interceptors: Interceptor[]): Promise<Running> {
    const server = createServer({ host: "127.0.0.1", port: 0, allowHTTP1: false, shutdown: { autoShutdown: false, timeout: 100 }, interceptors, services: [routes()] });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server must bind a port");
    const baseUrl = `http://127.0.0.1:${port}`;
    return { server, baseUrl, session: new Http2SessionManager(baseUrl) };
}

async function stop(running: Running): Promise<void> {
    running.session.abort();
    await running.server.stop();
}

/** Reads a server-streaming call to its end: the values received, and the error that ended it, if any. */
async function readServerStream(transport: Transport): Promise<{ values: string[]; error?: ConnectError }> {
    const values: string[] = [];
    try {
        for await (const item of createClient(StreamingService, transport).server({ value: "go", sequence: 1 }, { timeoutMs: 5_000 })) {
            values.push(item.value);
        }
    } catch (error) {
        return { values, error: ConnectError.from(error) };
    }
    return { values };
}

const protocols: readonly Protocol[] = ["gRPC", "Connect"];

describe("fallback for a streaming call, over real connections", () => {
    describe("server-side, skipStreaming: false", () => {
        const provider: Provider = { calls: 0 };
        let running: Running;

        before(async () => {
            running = await startServer([fallbackFor(provider, { skipStreaming: false }), failOpening(Code.Unavailable)]);
        });
        after(async () => {
            await stop(running);
        });

        for (const protocol of protocols) {
            it(`${protocol}: a server-streaming call whose opening fails receives the provider's message as its only message`, async () => {
                provider.calls = 0;

                const { values, error } = await readServerStream(transportFor(protocol, running.baseUrl, running.session));

                assert.equal(error, undefined, `the call must end without the failure, got ${error?.code} ${error?.rawMessage}`);
                assert.deepEqual(values, [FALLBACK_VALUE]);
                assert.equal(provider.calls, 1);
            });

            it(`${protocol}: a bidirectional call whose opening fails receives the provider's message as its only message`, async () => {
                provider.calls = 0;
                const client = createClient(StreamingService, transportFor(protocol, running.baseUrl, running.session));
                const values: string[] = [];

                for await (const item of client.bidi(oneItem(), { timeoutMs: 5_000 })) {
                    values.push(item.value);
                }

                assert.deepEqual(values, [FALLBACK_VALUE]);
                assert.equal(provider.calls, 1);
            });

            it(`${protocol}: a client-streaming call whose opening fails receives the provider's message as its single response`, async () => {
                provider.calls = 0;
                const client = createClient(StreamingService, transportFor(protocol, running.baseUrl, running.session));

                const response = await client.client(oneItem(), { timeoutMs: 5_000 });

                assert.equal(response.total, 99);
                assert.equal(provider.calls, 1);
            });

            it(`${protocol}: a unary call still receives the provider's message`, async () => {
                provider.calls = 0;
                const client = createClient(StreamingService, transportFor(protocol, running.baseUrl, running.session));

                const response = await client.echo({ value: "ping", sequence: 3 }, { timeoutMs: 5_000 });

                assert.equal(response.value, FALLBACK_VALUE);
                assert.equal(provider.calls, 1);
            });
        }
    });

    describe("what the fallback must leave alone", () => {
        for (const protocol of protocols) {
            it(`${protocol}: by default a streaming opening failure reaches the caller as it is and the provider is not asked`, async () => {
                const provider: Provider = { calls: 0 };
                const running = await startServer([fallbackFor(provider, {}), failOpening(Code.Unavailable)]);
                try {
                    const { values, error } = await readServerStream(transportFor(protocol, running.baseUrl, running.session));

                    assert.deepEqual(values, []);
                    assert.equal(error?.code, Code.Unavailable);
                    assert.equal(provider.calls, 0);
                } finally {
                    await stop(running);
                }
            });

            it(`${protocol}: with skipStreaming: false a refusal of access at the opening is not replaced`, async () => {
                const provider: Provider = { calls: 0 };
                const running = await startServer([fallbackFor(provider, { skipStreaming: false }), failOpening(Code.PermissionDenied)]);
                try {
                    const { values, error } = await readServerStream(transportFor(protocol, running.baseUrl, running.session));

                    assert.deepEqual(values, []);
                    assert.equal(error?.code, Code.PermissionDenied);
                    assert.equal(provider.calls, 0);
                } finally {
                    await stop(running);
                }
            });

            it(`${protocol}: with skipStreaming: false a failure after the first message is not replaced`, async () => {
                const provider: Provider = { calls: 0 };
                const running = await startServer([fallbackFor(provider, { skipStreaming: false }), failAfterFirstMessage()]);
                try {
                    const { values, error } = await readServerStream(transportFor(protocol, running.baseUrl, running.session));

                    assert.deepEqual(values, ["normal-first"]);
                    assert.equal(error?.code, Code.Unavailable);
                    assert.equal(provider.calls, 0);
                } finally {
                    await stop(running);
                }
            });
        }
    });
});
