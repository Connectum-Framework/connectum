/**
 * `server.stop()` aborts the handler signal of in-process calls exactly as it
 * does for HTTP calls.
 *
 * The in-process router receives the server's shutdown signal, so cleanup
 * code that watches `context.signal` runs on both transports: a unary handler
 * waiting on the signal ends with `Canceled`, a server stream ends with
 * `Canceled` after the messages it already sent, and a handler that ignores
 * the signal is not killed — shutdown does not wait for it either, because no
 * connection carries an in-process call (there is nothing for the force-close
 * timeout to destroy). Calls made before `start()` or after `stop()` keep
 * working against the server's current signal.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type HandlerContext } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/** Resolves when the handler is entered; the handler then waits for its signal and rethrows the abort as a ConnectError. */
function makeSignalAwaitingEcho() {
    let onEnter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
        onEnter = resolve;
    });
    const seen: { signal: AbortSignal | null } = { signal: null };
    const wait = (ctx: HandlerContext) =>
        new Promise<never>((_resolve, reject) => {
            seen.signal = ctx.signal;
            onEnter();
            ctx.signal.addEventListener("abort", () => reject(ConnectError.from(ctx.signal.reason)), { once: true });
        });
    const routes = defineService(EchoService, {
        echo: (_req, ctx) => wait(ctx),
        secureEcho: (_req, ctx) => wait(ctx),
        rateLimitedEcho: (_req, ctx) => wait(ctx),
    });
    return { routes, entered, seen };
}

/** A server stream that sends one item, then waits for its signal and rethrows the abort. */
function makeStreamingRoutes(entered: () => void) {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        async *server(_req, ctx) {
            yield create(ItemSchema, { value: "first", sequence: 1 });
            entered();
            await new Promise<void>((_resolve, reject) => {
                ctx.signal.addEventListener("abort", () => reject(ConnectError.from(ctx.signal.reason)), { once: true });
            });
        },
        client: async () => create(CountSchema, { total: 0 }),
        async *bidi() {},
    });
}

async function captureError(call: () => Promise<unknown>): Promise<ConnectError> {
    try {
        await call();
    } catch (err) {
        return ConnectError.from(err);
    }
    assert.fail("expected the call to fail");
}

describe("server.stop() aborts in-process calls like HTTP calls", () => {
    it("aborts a pending local unary handler and ends the call with Canceled", async () => {
        const echo = makeSignalAwaitingEcho();
        const server = createServer({ services: [echo.routes], port: 0 });
        await server.start();
        const pending = captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" })));
        await echo.entered;
        await server.stop();
        assert.strictEqual(echo.seen.signal?.aborted, true);
        assert.strictEqual((await pending).code, Code.Canceled);
    });

    it("ends a local server stream with Canceled after the messages already sent, as over HTTP", async () => {
        for (const kind of ["http", "local"] as const) {
            let onEnter: () => void = () => {};
            const entered = new Promise<void>((resolve) => {
                onEnter = resolve;
            });
            const server = createServer({ services: [makeStreamingRoutes(onEnter)], port: 0, allowHTTP1: false, shutdown: { timeout: 5_000 } });
            await server.start();
            const client =
                kind === "http"
                    ? createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }))
                    : server.localClient(StreamingService);
            const received: string[] = [];
            const pending = captureError(async () => {
                for await (const item of client.server(create(ItemSchema, { value: "x", sequence: 0 }))) {
                    received.push(item.value);
                }
            });
            await entered;
            await server.stop();
            const err = await pending;
            assert.deepStrictEqual(received, ["first"], `${kind}: messages sent before shutdown must arrive`);
            assert.strictEqual(err.code, Code.Canceled, `${kind}: the stream must end with Canceled`);
        }
    });

    it("does not wait for a local handler that ignores the signal, and does not kill it", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let onEnter: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
            onEnter = resolve;
        });
        const stubborn = defineService(EchoService, {
            echo: async (req) => {
                onEnter();
                await gate;
                return create(EchoResponseSchema, { message: `late:${req.message}`, timestamp: 0n });
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const server = createServer({ services: [stubborn], port: 0, shutdown: { timeout: 10_000 } });
        await server.start();
        const pending = server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        await entered;
        const started = Date.now();
        await server.stop();
        assert.ok(Date.now() - started < 5_000, "stop() must not wait for in-process calls: no connection carries them");
        release();
        const res = await pending;
        assert.strictEqual(res.message, "late:a", "a handler that ignores the signal still completes its call");
    });

    it("a server that was never started serves local calls with a live signal", async () => {
        const seen: { aborted: boolean | null } = { aborted: null };
        const server = createServer({
            services: [
                defineService(EchoService, {
                    echo: (req, ctx) => {
                        seen.aborted = ctx.signal.aborted;
                        return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
                    },
                    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                }),
            ],
        });
        const res = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        assert.strictEqual(res.message, "a");
        assert.strictEqual(seen.aborted, false);
    });

    it("after stop(), a local call starts with an already-aborted signal", async () => {
        const seen: { aborted: boolean | null } = { aborted: null };
        const server = createServer({
            services: [
                defineService(EchoService, {
                    echo: (req, ctx) => {
                        seen.aborted = ctx.signal.aborted;
                        if (ctx.signal.aborted) {
                            throw new ConnectError("server is shutting down", Code.Unavailable);
                        }
                        return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
                    },
                    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                }),
            ],
            port: 0,
        });
        await server.start();
        await server.stop();
        const err = await captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" })));
        assert.strictEqual(seen.aborted, true, "the handler must see the server is stopped");
        assert.strictEqual(err.code, Code.Unavailable);
    });
});
