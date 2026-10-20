/**
 * In-process transport regression tests.
 *
 * Verifies the foundation invariants for the in-process transport:
 *   - createLocalTransport / server.localClient work without server.start()
 *   - no TCP port is bound (server.address === null)
 *   - request and response header round-trip through the in-memory pipe
 *
 * These tests intentionally do NOT call server.start() to prove the HTTP socket
 * is unnecessary for the in-process path.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import { defineService } from "../../src/defineService.ts";
import { createLocalTransport } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

function makeEchoRoutes() {
    return defineService(EchoService, {
        echo: (req, ctx: HandlerContext) => {
            const correlation = ctx.requestHeader.get("x-correlation-id") ?? "";
            if (correlation) {
                ctx.responseHeader.set("x-correlation-echo", correlation);
            }
            ctx.responseHeader.set("x-trace-id", "def-456");
            return create(EchoResponseSchema, {
                message: `echo:${req.message}`,
                timestamp: 0n,
            });
        },
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

describe("createLocalTransport / server.localClient", () => {
    it("server.localClient invokes registered service without start()", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });

        assert.strictEqual(server.address, null, "address must be null before start()");

        const client = server.localClient(EchoService);
        const response = await client.echo(create(EchoRequestSchema, { message: "hello" }));

        assert.strictEqual(response.message, "echo:hello");
        assert.strictEqual(server.address, null, "address must remain null after local call");
    });

    it("createLocalTransport returns a working Transport without start()", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const transport = createLocalTransport(server);

        const { createClient } = await import("@connectrpc/connect");
        const client = createClient(EchoService, transport);
        const response = await client.echo(create(EchoRequestSchema, { message: "abc" }));

        assert.strictEqual(response.message, "echo:abc");
        assert.strictEqual(server.address, null);
    });

    // Oracle: the route-materialization contract says a protocol's `register(router)`
    // runs "once per router built" (HTTP adapter, local client transport, catalog
    // transport) and `setup` once per server. Every extra in-process transport would be
    // one more router, so a protocol that counts its `register` calls observes the
    // transport without touching any private field: the local client transport is one
    // router, and further `localClient()` calls must not build another.
    it("builds one local-transport router however many localClient() calls are made", async () => {
        let setupCalls = 0;
        let registerCalls = 0;
        const server = createServer({
            services: [makeEchoRoutes()],
            protocols: [
                {
                    name: "counting",
                    setup() {
                        setupCalls++;
                    },
                    register() {
                        registerCalls++;
                    },
                },
            ],
        });
        assert.strictEqual(registerCalls, 0, "nothing is built before the first in-process client");

        const first = server.localClient(EchoService);
        // The first call builds the server's routes (the HTTP adapter's router) and the
        // local client transport (one more router); a later call adds nothing.
        const afterFirst = registerCalls;
        assert.strictEqual(afterFirst, 2, "HTTP adapter router + the local client transport's router");

        const second = server.localClient(EchoService);
        assert.strictEqual(registerCalls, afterFirst, "a second localClient() must reuse the transport, not build another router");
        assert.strictEqual(setupCalls, 1, "setup runs once per server");

        // Both clients are usable and reach the same registered service.
        assert.strictEqual((await first.echo(create(EchoRequestSchema, { message: "a" }))).message, "echo:a");
        assert.strictEqual((await second.echo(create(EchoRequestSchema, { message: "b" }))).message, "echo:b");
        assert.strictEqual(registerCalls, afterFirst, "calling through the clients builds no further router");
    });

    // Oracle for addProtocol: the custom-protocol guide ("Add protocols before
    // server.start() and before creating an in-process client: either action
    // materializes routes and prevents later addProtocol() calls"). The message text
    // exists only in the implementation, so the type and the unchanged list are checked.
    it("rejects addProtocol() once an in-process client has materialized the routes", () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        server.localClient(EchoService);
        const protocolsBefore = server.protocols.length;

        assert.throws(() => server.addProtocol({ name: "x", register: () => {} }), Error);
        assert.strictEqual(server.protocols.length, protocolsBefore);
    });

    // Connectum decision, no documented source: the guides and contracts forbid late
    // addProtocol() only. addService() and addInterceptor() follow the same rule, because
    // the routes and their interceptor chain are built once and cached, so a service or
    // interceptor added afterwards would be accepted and silently never served. The
    // contract only covers additions made BEFORE any client exists ("Registry reflects
    // services added before materialization"); the rejection after materialization is the
    // chosen counterpart. The test pins both halves: the call throws, and the service
    // that was not mounted stays unreachable instead of being half-registered.
    it("rejects addService() and addInterceptor() after materialization instead of ignoring them silently", () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        server.localClient(EchoService);
        const routesBefore = server.routes.length;
        const interceptorsBefore = server.interceptors.length;

        assert.throws(() => server.addService({ descriptor: StreamingService, register: () => {} }), Error);
        assert.throws(() => server.addInterceptor((next) => next), Error);

        assert.strictEqual(server.routes.length, routesBefore);
        assert.strictEqual(server.interceptors.length, interceptorsBefore);
        assert.strictEqual(server.hasService(StreamingService), false);
    });
});

describe("Headers round-trip", () => {
    it("propagates a custom request header to the handler", async () => {
        let seen: string | null = null;
        const routes = defineService(EchoService, {
            echo: (req, ctx: HandlerContext) => {
                seen = ctx.requestHeader.get("x-correlation-id");
                return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const server = createServer({ services: [routes] });

        const setHeaderInterceptor =
            ((next) => async (req) => {
                req.header.set("x-correlation-id", "abc-123");
                return next(req);
            }) satisfies import("@connectrpc/connect").Interceptor;

        const transport = createLocalTransport(server, { interceptors: [setHeaderInterceptor] });
        const { createClient } = await import("@connectrpc/connect");
        const client = createClient(EchoService, transport);

        await client.echo(create(EchoRequestSchema, { message: "ping" }));
        assert.strictEqual(seen, "abc-123");
    });

    it("exposes response headers set by the handler back to the client", async () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        const { createClient } = await import("@connectrpc/connect");
        const client = createClient(EchoService, createLocalTransport(server));

        // Use the call-options variant to capture response headers.
        const headers: Headers = new Headers();
        await client.echo(create(EchoRequestSchema, { message: "h" }), {
            onHeader: (h) => {
                for (const [k, v] of h) headers.set(k, v);
            },
        });

        assert.strictEqual(headers.get("x-trace-id"), "def-456");
    });

    it("Headers mutation on one side is isolated from the other side", async () => {
        const clientHeaderRef: { value: Headers | null } = { value: null };
        const routes = defineService(EchoService, {
            echo: (req, ctx: HandlerContext) => {
                // Mutate request headers on server side — must not propagate back.
                ctx.requestHeader.set("server-only", "leaked");
                return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const server = createServer({ services: [routes] });
        const captureHeaderInterceptor =
            ((next) => async (req) => {
                clientHeaderRef.value = req.header;
                return next(req);
            }) satisfies import("@connectrpc/connect").Interceptor;
        const transport = createLocalTransport(server, { interceptors: [captureHeaderInterceptor] });
        const { createClient } = await import("@connectrpc/connect");
        const client = createClient(EchoService, transport);

        await client.echo(create(EchoRequestSchema, { message: "x" }));

        assert.ok(clientHeaderRef.value, "client-side header captured");
        assert.strictEqual(
            clientHeaderRef.value.get("server-only"),
            null,
            "server-side header mutation must not leak to client request Headers",
        );
    });
});

describe("Synthetic origin", () => {
    it("a client-side interceptor sees the same synthetic url, with exactly /<service>/<method> as its path", async () => {
        const observedUrls: string[] = [];
        const server = createServer({ services: [makeEchoRoutes()] });

        const urlSniffer =
            ((next) => async (req) => {
                observedUrls.push(req.url);
                return next(req);
            }) satisfies import("@connectrpc/connect").Interceptor;

        const transport = createLocalTransport(server, { interceptors: [urlSniffer] });
        const { createClient } = await import("@connectrpc/connect");
        const client = createClient(EchoService, transport);

        await client.echo(create(EchoRequestSchema, { message: "u" }));

        // The user guide gives `https://in-memory/<service>/<method>` as the URL of a local call.
        assert.deepStrictEqual(observedUrls, [`https://in-memory/${EchoService.typeName}/${EchoService.method.echo.name}`]);
    });

    // The user guide tells authors of policy interceptors that a local call
    // shows `https://in-memory/<service>/<method>` in `req.url` and that they
    // must decide on `req.service.typeName` / `req.method.name` instead. The
    // origin comes from `@connectrpc/connect`'s router transport, not from
    // Connectum, so a dependency upgrade could change it silently; this pins
    // the exact value a server-side interceptor sees, so the guide cannot
    // drift from reality unnoticed.
    it("a server interceptor sees req.url = https://in-memory/<service>/<method> on a local call", async () => {
        const observed: Array<{ url: string; service: string; method: string }> = [];
        const server = createServer({
            services: [makeEchoRoutes()],
            interceptors: [
                ((next) => async (req) => {
                    observed.push({ url: req.url, service: req.service.typeName, method: req.method.name });
                    return next(req);
                }) satisfies import("@connectrpc/connect").Interceptor,
            ],
        });

        await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "u" }));

        assert.deepStrictEqual(observed, [
            {
                url: `https://in-memory/${EchoService.typeName}/${EchoService.method.echo.name}`,
                service: "echo.v1.EchoService",
                method: "Echo",
            },
        ]);
    });
});
