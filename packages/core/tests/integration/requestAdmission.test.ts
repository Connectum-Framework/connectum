/**
 * Server-level request admission: `createServer({ requestGate, readMaxBytes })`.
 *
 * These tests pin the contract users rely on when they reject requests before
 * the body is read:
 * - the gate and the read limit apply identically over HTTP and in-process;
 * - a rejected request never has its body read (not just "not parsed");
 * - a gate's error reaches the client verbatim, bypassing server interceptors;
 * - service options replace the server defaults (no composition, no ceiling);
 * - HTTP endpoints served by protocol HTTP handlers sit outside the gate;
 * - cancellation of a pending gate is cooperative, and in-process calls are not
 *   aborted by server shutdown;
 * - a forged internal transport marker is invisible to every gate on HTTP.
 */

import assert from "node:assert";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { buildRoutes } from "../../src/buildRoutes.ts";
import type { RegisterContext, ServiceOptions } from "../../src/defineService.ts";
import { defineService } from "../../src/defineService.ts";
import { createLocalTransport, LOCAL_TRANSPORT_HEADER, LOCAL_TRANSPORT_VALUE } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import type { CreateServerOptions, NodeRequest, NodeResponse, ProtocolRegistration, Server } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/** Counts handler invocations so a test can prove the handler never ran. */
function makeEchoRoutes(calls: { count: number }, options?: ServiceOptions) {
    const echo = (req: { message: string }) => {
        calls.count++;
        return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
    };
    return defineService(EchoService, { echo, secureEcho: echo, rateLimitedEcho: echo }, options);
}

/** A second, independent service to show that a service override stays local to that service. */
function makeStreamingRoutes(calls: { count: number }, options?: ServiceOptions) {
    return defineService(
        StreamingService,
        {
            echo: (req) => {
                calls.count++;
                return create(ItemSchema, { value: req.value, sequence: req.sequence });
            },
            async *server() {},
            client: async () => {
                throw new ConnectError("unused", Code.Unimplemented);
            },
            async *bidi() {},
        },
        options,
    );
}

const rejectAll = (): void => {
    throw new ConnectError("unauthenticated", Code.Unauthenticated);
};

/** Start an h2c server (gRPC clients need HTTP/2 without TLS) and return a gRPC transport to it. */
async function startH2c(options: Omit<CreateServerOptions, "port" | "allowHTTP1">) {
    const server = createServer({ ...options, port: 0, allowHTTP1: false });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "server must bind a port");
    return { server, transport: createGrpcTransport({ baseUrl: `http://localhost:${port}` }) };
}

async function captureError(call: () => Promise<unknown>): Promise<ConnectError> {
    try {
        await call();
    } catch (err) {
        return ConnectError.from(err);
    }
    assert.fail("expected the call to fail");
}

/** A request message whose binary encoding is exactly `size` bytes (tag + 1-byte length + payload). */
function echoOfEncodedSize(size: number) {
    assert.ok(size >= 2 && size < 130, "helper covers single-byte length prefixes only");
    return create(EchoRequestSchema, { message: "x".repeat(size - 2) });
}

describe("requestGate — server default on both transports", () => {
    it("admits the call when the gate returns, over HTTP and in-process", async () => {
        const calls = { count: 0 };
        const seen: string[] = [];
        const gate = (ctx: HandlerContext) => {
            seen.push(ctx.method.name);
        };
        const { server, transport } = await startH2c({ services: [makeEchoRoutes(calls)], requestGate: gate });
        try {
            const viaHttp = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "a" }));
            const viaLocal = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
            assert.strictEqual(viaHttp.message, "echo:a");
            assert.strictEqual(viaLocal.message, "echo:a");
            assert.deepStrictEqual(seen, ["Echo", "Echo"], "gate must run once per call on each transport");
            assert.strictEqual(calls.count, 2);
        } finally {
            await server.stop();
        }
    });

    it("rejects with the gate's error and never invokes the handler, over HTTP and in-process", async () => {
        const calls = { count: 0 };
        const { server, transport } = await startH2c({ services: [makeEchoRoutes(calls)], requestGate: rejectAll });
        try {
            const httpErr = await captureError(() => createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "a" })));
            const localErr = await captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" })));
            for (const err of [httpErr, localErr]) {
                assert.strictEqual(err.code, Code.Unauthenticated);
                assert.strictEqual(err.rawMessage, "unauthenticated");
            }
            assert.strictEqual(calls.count, 0, "handler must not run for a rejected call");
        } finally {
            await server.stop();
        }
    });

    it("bypasses server interceptors: the gate's error is not rewritten and interceptors never run", async () => {
        const calls = { count: 0 };
        const intercepted: string[] = [];
        // Stands in for an error-sanitising interceptor such as errorHandler.
        const rewriteErrors: Interceptor = (next) => async (req) => {
            intercepted.push(req.method.name);
            try {
                return await next(req);
            } catch {
                throw new ConnectError("sanitised", Code.Internal);
            }
        };
        const gate = (): void => {
            throw new ConnectError("denied", Code.PermissionDenied);
        };
        const server = createServer({ services: [makeEchoRoutes(calls)], interceptors: [rewriteErrors], requestGate: gate });

        const err = await captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" })));
        assert.strictEqual(err.code, Code.PermissionDenied);
        assert.strictEqual(err.rawMessage, "denied", "the gate's message must reach the client unchanged");
        assert.deepStrictEqual(intercepted, [], "no server interceptor may run for a rejected call");
    });

    it("lets client-side interceptors observe the rejection", async () => {
        const observed: Array<Code | "ok"> = [];
        const clientProbe: Interceptor = (next) => async (req) => {
            try {
                const res = await next(req);
                observed.push("ok");
                return res;
            } catch (err) {
                observed.push(ConnectError.from(err).code);
                throw err;
            }
        };
        const server = createServer({ services: [makeEchoRoutes({ count: 0 })], requestGate: rejectAll });
        const transport = createLocalTransport(server, { interceptors: [clientProbe] });
        await captureError(() => createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "a" })));
        assert.deepStrictEqual(observed, [Code.Unauthenticated]);
    });
});

describe("requestGate — the request body of a rejected call is never read", () => {
    /**
     * Drives the real HTTP handler built by buildRoutes from a plain node:http
     * server whose request objects count every attempt to iterate the body.
     * connect-node reads the body only through `request[Symbol.asyncIterator]`,
     * so zero iterations proves the body was not touched at all.
     */
    async function serveInstrumented(requestGate: CreateServerOptions["requestGate"]) {
        const bodyReads = { count: 0 };
        const calls = { count: 0 };
        // Identity wrapper: the echo handlers never use ctx.call.
        const registerContext: RegisterContext = {
            wrapHandlers: ((_descriptor: unknown, handlers: unknown) => handlers) as RegisterContext["wrapHandlers"],
        };
        const { handler } = buildRoutes({
            services: [makeEchoRoutes(calls)],
            protocols: [],
            interceptors: [],
            shutdownSignal: new AbortController().signal,
            registerContext,
            ...(requestGate !== undefined ? { requestGate } : {}),
        });
        const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
            const original = req[Symbol.asyncIterator].bind(req);
            req[Symbol.asyncIterator] = () => {
                bodyReads.count++;
                return original();
            };
            handler(req as NodeRequest, res as NodeResponse);
        });
        await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
        const { port } = http.address() as AddressInfo;
        const post = () =>
            fetch(`http://127.0.0.1:${port}/echo.v1.EchoService/Echo`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ message: "body" }),
            });
        const close = () => new Promise<void>((resolve) => http.close(() => resolve()));
        return { bodyReads, calls, post, close };
    }

    it("iterates the body when the gate admits the call (the probe works)", async () => {
        const h = await serveInstrumented(() => {});
        try {
            const res = await h.post();
            assert.strictEqual(res.status, 200);
            await res.text();
            assert.ok(h.bodyReads.count > 0, "an admitted call must read its body");
            assert.strictEqual(h.calls.count, 1);
        } finally {
            await h.close();
        }
    });

    it("never iterates the body when the gate rejects the call", async () => {
        const h = await serveInstrumented(rejectAll);
        try {
            const res = await h.post();
            const body = (await res.json()) as { code: string; message: string };
            assert.deepStrictEqual(body, { code: "unauthenticated", message: "unauthenticated" });
            assert.strictEqual(h.bodyReads.count, 0, "a rejected call must not touch the request body");
            assert.strictEqual(h.calls.count, 0);
        } finally {
            await h.close();
        }
    });
});

describe("readMaxBytes — server default on both transports", () => {
    it("rejects an over-limit message with ResourceExhausted before the handler, over HTTP and in-process", async () => {
        const calls = { count: 0 };
        const { server, transport } = await startH2c({ services: [makeEchoRoutes(calls)], readMaxBytes: 64 });
        try {
            const httpErr = await captureError(() => createClient(EchoService, transport).echo(echoOfEncodedSize(65)));
            const localErr = await captureError(() => server.localClient(EchoService).echo(echoOfEncodedSize(65)));
            assert.strictEqual(httpErr.code, Code.ResourceExhausted);
            assert.strictEqual(localErr.code, Code.ResourceExhausted);
            // The diagnostic text may differ (HTTP knows the envelope size up
            // front); both name the configured limit.
            assert.match(httpErr.rawMessage, /readMaxBytes 64$/);
            assert.match(localErr.rawMessage, /readMaxBytes 64$/);
            assert.strictEqual(calls.count, 0);
        } finally {
            await server.stop();
        }
    });

    it("accepts a message exactly at the limit, over HTTP and in-process", async () => {
        const calls = { count: 0 };
        const { server, transport } = await startH2c({ services: [makeEchoRoutes(calls)], readMaxBytes: 64 });
        try {
            await createClient(EchoService, transport).echo(echoOfEncodedSize(64));
            await server.localClient(EchoService).echo(echoOfEncodedSize(64));
            assert.strictEqual(calls.count, 2);
        } finally {
            await server.stop();
        }
    });

    it("rejects an out-of-range value when the server starts, with Code.Internal", async () => {
        const server = createServer({ services: [makeEchoRoutes({ count: 0 })], port: 0, readMaxBytes: 0 });
        server.on("error", () => {});
        const err = await captureError(() => server.start());
        assert.strictEqual(err.code, Code.Internal);
        assert.match(err.rawMessage, /readMaxBytes 0 must be >= 1/);
    });
});

describe("service options override the server defaults", () => {
    it("a service gate replaces the server gate for that service only", async () => {
        const serverGateCalls: string[] = [];
        const serverGate = (ctx: HandlerContext): void => {
            serverGateCalls.push(ctx.service.typeName);
            throw new ConnectError("server gate", Code.Unauthenticated);
        };
        const server = createServer({
            services: [makeEchoRoutes({ count: 0 }, { requestGate: () => {} }), makeStreamingRoutes({ count: 0 })],
            requestGate: serverGate,
        });
        const ok = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        assert.strictEqual(ok.message, "echo:a", "service gate admits");
        const err = await captureError(() => server.localClient(StreamingService).echo(create(ItemSchema, { value: "a" })));
        assert.strictEqual(err.rawMessage, "server gate", "other services keep the server gate");
        assert.deepStrictEqual(serverGateCalls, [StreamingService.typeName], "server gate must not run for the overriding service");
    });

    it("a larger service readMaxBytes raises the limit for that service only (a default, not a ceiling)", async () => {
        const server = createServer({
            services: [makeEchoRoutes({ count: 0 }, { readMaxBytes: 1024 }), makeStreamingRoutes({ count: 0 })],
            readMaxBytes: 64,
        });
        const big = "x".repeat(200);
        const ok = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: big }));
        assert.strictEqual(ok.message, `echo:${big}`);
        const err = await captureError(() => server.localClient(StreamingService).echo(create(ItemSchema, { value: big })));
        assert.strictEqual(err.code, Code.ResourceExhausted);
    });

    it("an own `requestGate: undefined` key in service options removes the server gate", async () => {
        // Typed code cannot write this under exactOptionalPropertyTypes, but a
        // spread of a partially-filled options object does produce it at
        // runtime — and upstream merges `{ ...serverOptions, ...serviceOptions }`.
        const spreadResult: Record<string, unknown> = { requestGate: undefined };
        const server = createServer({
            services: [makeEchoRoutes({ count: 0 }, spreadResult as ServiceOptions)],
            requestGate: rejectAll,
        });
        const ok = await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));
        assert.strictEqual(ok.message, "echo:a");
    });
});

describe("gate coverage boundary", () => {
    it("serves a protocol HTTP handler endpoint without invoking the gate", async () => {
        const gateCalls = { count: 0 };
        const plainHttp: ProtocolRegistration = {
            name: "plain-http",
            register: () => {},
            httpHandler: (req, res) => {
                if (req.url !== "/plain") return false;
                res.statusCode = 200;
                res.end("plain");
                return true;
            },
        };
        const server = createServer({
            services: [makeEchoRoutes({ count: 0 })],
            protocols: [plainHttp],
            port: 0,
            requestGate: () => {
                gateCalls.count++;
                throw new ConnectError("no", Code.Unauthenticated);
            },
        });
        await server.start();
        try {
            const res = await fetch(`http://127.0.0.1:${server.address?.port}/plain`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.text(), "plain");
            assert.strictEqual(gateCalls.count, 0, "fallback HTTP handlers are outside the gate");
        } finally {
            await server.stop();
        }
    });
});

describe("gate cancellation is cooperative", () => {
    /** A gate that parks until its context signal aborts, then ends the call with the abort reason. */
    function makeParkingGate() {
        const state = { entered: 0, aborted: 0, lastSignal: null as AbortSignal | null };
        let onEnter: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
            onEnter = resolve;
        });
        const gate = (ctx: HandlerContext): Promise<void> => {
            state.entered++;
            state.lastSignal = ctx.signal;
            onEnter();
            return new Promise<void>((_resolve, reject) => {
                ctx.signal.addEventListener(
                    "abort",
                    () => {
                        state.aborted++;
                        reject(ConnectError.from(ctx.signal.reason));
                    },
                    { once: true },
                );
            });
        };
        return { gate, state, entered };
    }

    it("releases a pending gate on the call deadline, over HTTP and in-process", async () => {
        const parking = makeParkingGate();
        const { server, transport } = await startH2c({ services: [makeEchoRoutes({ count: 0 })], requestGate: parking.gate });
        try {
            const httpErr = await captureError(() => createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "a" }), { timeoutMs: 50 }));
            const localErr = await captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }), { timeoutMs: 50 }));
            assert.strictEqual(httpErr.code, Code.DeadlineExceeded);
            assert.strictEqual(localErr.code, Code.DeadlineExceeded);
            // Wait for both server-side deadline signals to reach the gate.
            for (let i = 0; i < 50 && parking.state.aborted < 2; i++) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            assert.strictEqual(parking.state.entered, 2);
            assert.strictEqual(parking.state.aborted, 2, "the deadline must abort the gate's signal on both transports");
        } finally {
            await server.stop();
        }
    });

    it("releases a pending HTTP gate when the server stops", async () => {
        const parking = makeParkingGate();
        const { server, transport } = await startH2c({
            services: [makeEchoRoutes({ count: 0 })],
            requestGate: parking.gate,
            shutdown: { timeout: 5_000 },
        });
        const pending = captureError(() => createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "a" })));
        await parking.entered;
        await server.stop();
        assert.strictEqual(parking.state.aborted, 1, "server shutdown must abort a pending HTTP gate's signal");
        // server.stop() aborts without a reason, so the gate rethrows an
        // AbortError, which Connect maps to Canceled.
        const err = await pending;
        assert.strictEqual(err.code, Code.Canceled);
    });

    it("does not abort a pending in-process gate on server shutdown; the client's cancellation releases it", async () => {
        const parking = makeParkingGate();
        const server: Server = createServer({ services: [makeEchoRoutes({ count: 0 })], requestGate: parking.gate, port: 0 });
        await server.start();
        const controller = new AbortController();
        const pending = captureError(() => server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }), { signal: controller.signal }));
        await parking.entered;
        await server.stop();
        assert.strictEqual(parking.state.lastSignal?.aborted, false, "server shutdown must not abort an in-process gate");
        assert.strictEqual(parking.state.aborted, 0);
        controller.abort();
        const err = await pending;
        assert.strictEqual(err.code, Code.Canceled);
        for (let i = 0; i < 50 && parking.state.aborted < 1; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.strictEqual(parking.state.aborted, 1, "client cancellation must reach the in-process gate");
    });
});

describe("a forged internal transport marker is invisible to gates over HTTP", () => {
    it("server-level gate over HTTP/1.1 does not see the forged marker", async () => {
        const seen: Array<string | null> = [];
        const server = createServer({
            services: [makeEchoRoutes({ count: 0 })],
            port: 0,
            requestGate: (ctx) => {
                seen.push(ctx.requestHeader.get(LOCAL_TRANSPORT_HEADER));
            },
        });
        await server.start();
        try {
            const res = await fetch(`http://127.0.0.1:${server.address?.port}/echo.v1.EchoService/Echo`, {
                method: "POST",
                headers: { "content-type": "application/json", "Connectum-Internal-Transport": LOCAL_TRANSPORT_VALUE },
                body: JSON.stringify({ message: "spoof" }),
            });
            assert.strictEqual(res.status, 200);
            await res.text();
            assert.deepStrictEqual(seen, [null], "a gate must never observe a forged marker on HTTP");
        } finally {
            await server.stop();
        }
    });

    it("service-level gate over HTTP/2 does not see the forged marker; in-process calls still carry it", async () => {
        const seen: Array<string | null> = [];
        const serviceGate = (ctx: HandlerContext) => {
            seen.push(ctx.requestHeader.get(LOCAL_TRANSPORT_HEADER));
        };
        const server = createServer({ services: [makeEchoRoutes({ count: 0 }, { requestGate: serviceGate })], port: 0, allowHTTP1: false });
        await server.start();
        try {
            const forge: Interceptor = (next) => (req) => {
                req.header.set(LOCAL_TRANSPORT_HEADER, LOCAL_TRANSPORT_VALUE);
                return next(req);
            };
            const transport = createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}`, interceptors: [forge] });
            await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "spoof" }));
            await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "legit" }));
            assert.deepStrictEqual(seen, [null, LOCAL_TRANSPORT_VALUE]);
        } finally {
            await server.stop();
        }
    });
});
