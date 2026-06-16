/**
 * In-process transport — Phase 1 regression tests.
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

describe("createLocalTransport / server.localClient (Phase 1)", () => {
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

    it("memoizes the local transport across multiple localClient() calls", () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        // Access the private `_localTransport` slot to prove that the same
        // Transport instance is reused across `localClient()` calls — a
        // truthy check on the returned clients alone cannot distinguish
        // "memoized" from "re-created every call".
        const internal = server as unknown as { _localTransport: unknown };
        assert.strictEqual(internal._localTransport, null, "transport must be lazily created");

        const a = server.localClient(EchoService);
        const firstTransport = internal._localTransport;
        assert.ok(firstTransport, "transport must be materialized after first localClient() call");

        const b = server.localClient(EchoService);
        const secondTransport = internal._localTransport;
        assert.strictEqual(secondTransport, firstTransport, "underlying transport must be memoized across calls");

        // Sanity: the client wrappers themselves are independent values
        // (createClient returns a fresh wrapper each time) but they share
        // the same underlying transport, proven above.
        assert.ok(a);
        assert.ok(b);
    });

    it("locks addService / addInterceptor / addProtocol after routes are materialized", () => {
        const server = createServer({ services: [makeEchoRoutes()] });
        // Trigger lazy build.
        server.localClient(EchoService);

        assert.throws(() => server.addService({ descriptor: EchoService, register: () => {} }), /materialized/);
        assert.throws(() => server.addInterceptor((next) => next), /materialized/);
        assert.throws(
            () => server.addProtocol({ name: "x", register: () => {} }),
            /materialized/,
        );
    });
});

describe("Headers round-trip (Phase 2.1)", () => {
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

describe("Synthetic origin (Phase 2.3)", () => {
    it("interceptors observe a non-empty req.url with service/method in path", async () => {
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

        assert.strictEqual(observedUrls.length, 1);
        const url = observedUrls[0] ?? "";
        assert.ok(url.length > 0, "req.url must be non-empty");
        assert.ok(url.includes("echo.v1.EchoService"), `req.url must include service name, got: ${url}`);
        assert.ok(url.includes("Echo"), `req.url must include method name, got: ${url}`);
    });
});
