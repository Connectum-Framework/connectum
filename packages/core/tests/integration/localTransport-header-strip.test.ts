/**
 * Regression tests for security finding F1 (CWE-345) — HTTP-side stripping
 * of the `connectum-internal-transport` marker header.
 *
 * Threat model: a remote HTTP caller knows the header name (it is published
 * in `@connectum/otel` literals and historically in `@connectum/core`'s
 * public surface). Without server-side stripping, the caller can forge
 * `connectum-internal-transport: in-process` on the wire, and downstream
 * cross-cutting interceptors (notably `@connectum/otel`) would tag spans
 * and metrics as if the call originated from the in-memory pipe, poisoning
 * telemetry.
 *
 * Fix: `buildRoutes` prepends an HTTP-only interceptor (passed to
 * `connectNodeAdapter.interceptors`) that strips this header. The
 * in-process path (`createLocalTransport` -> `createRouterTransport`) does
 * NOT pass through `connectNodeAdapter`, so legitimate local calls retain
 * the marker end-to-end.
 *
 * These tests pin the invariants:
 *   F1.1 — Forged header on inbound HTTP request is invisible to the
 *          server interceptor chain.
 *   F1.2 — Legitimate `createLocalTransport` call still surfaces the
 *          marker to the server interceptor chain (regression guard).
 *   F1.3 — Server-side user interceptors observe a fresh `Headers`
 *          instance on HTTP with the marker absent regardless of casing.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { HandlerContext, Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createLocalTransport, LOCAL_TRANSPORT_HEADER, LOCAL_TRANSPORT_VALUE } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/**
 * Build a server-side interceptor that captures the value of
 * `connectum-internal-transport` header observed at the server boundary.
 * The capture box is shared so tests can read the observation.
 */
function makeTransportHeaderProbe(box: { value: string | null }): Interceptor {
    return (next) => (req) => {
        box.value = req.header.get(LOCAL_TRANSPORT_HEADER);
        return next(req);
    };
}

function makeEchoRoutes() {
    return defineService(EchoService, {
        echo: (req, _ctx: HandlerContext) =>
            create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

describe("F1 — Local transport header is stripped from inbound HTTP requests", () => {
    it("F1.1 — Forged `connectum-internal-transport` header from HTTP client is invisible at server interceptor chain", async () => {
        const observed: { value: string | null } = { value: "<not-called>" };
        const server = createServer({
            services: [makeEchoRoutes()],
            port: 0,
            // gRPC client over HTTP/2 plaintext requires the server to
            // refuse HTTP/1 upgrade (mirrors `coexistence.parity.test.ts`).
            allowHTTP1: false,
            interceptors: [makeTransportHeaderProbe(observed)],
        });
        await server.start();
        try {
            const port = server.address?.port;
            assert.ok(port, "server must bind a port");

            // Forge the marker via a client-side interceptor so it travels
            // on the HTTP/2 request headers exactly the way a malicious
            // caller would set it (mirroring the proof-of-concept from
            // SECURITY_REVIEW.md §4 F1).
            const forgeMarkerInterceptor: Interceptor = (next) => (req) => {
                req.header.set(LOCAL_TRANSPORT_HEADER, LOCAL_TRANSPORT_VALUE);
                return next(req);
            };
            const transport = createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [forgeMarkerInterceptor],
            });
            const client = createClient(EchoService, transport);

            await client.echo(create(EchoRequestSchema, { message: "spoof" }));

            assert.strictEqual(
                observed.value,
                null,
                `forged header must be stripped on HTTP entry, but server interceptor observed: ${observed.value}`,
            );
        } finally {
            await server.stop();
        }
    });

    it("F1.2 — Legitimate `createLocalTransport` call still carries the marker to the server interceptor chain", async () => {
        const observed: { value: string | null } = { value: "<not-called>" };
        const server = createServer({
            services: [makeEchoRoutes()],
            interceptors: [makeTransportHeaderProbe(observed)],
        });
        // Intentionally no server.start() — local path must work pre-start.

        const transport = createLocalTransport(server);
        const client = createClient(EchoService, transport);
        await client.echo(create(EchoRequestSchema, { message: "legit" }));

        assert.strictEqual(
            observed.value,
            LOCAL_TRANSPORT_VALUE,
            "legitimate in-process call must surface the marker to server interceptors",
        );
    });

    it("F1.3 — Forged header with mixed-case name is also stripped (Headers is case-insensitive)", async () => {
        const observed: { value: string | null } = { value: "<not-called>" };
        const server = createServer({
            services: [makeEchoRoutes()],
            port: 0,
            // gRPC client over HTTP/2 plaintext requires the server to
            // refuse HTTP/1 upgrade (mirrors `coexistence.parity.test.ts`).
            allowHTTP1: false,
            interceptors: [makeTransportHeaderProbe(observed)],
        });
        await server.start();
        try {
            const port = server.address?.port;
            assert.ok(port);

            // Mixed-case header name set via client interceptor — the
            // Headers API normalises to lower-case so the server-side
            // strip interceptor must still delete it.
            const forgeMarkerMixedCaseInterceptor: Interceptor = (next) => (req) => {
                req.header.set("Connectum-Internal-Transport", "in-process");
                return next(req);
            };
            const transport = createGrpcTransport({
                baseUrl: `http://localhost:${port}`,
                interceptors: [forgeMarkerMixedCaseInterceptor],
            });
            const client = createClient(EchoService, transport);

            await client.echo(create(EchoRequestSchema, { message: "spoof2" }));

            assert.strictEqual(observed.value, null, "case-variant forged header must also be stripped");
        } finally {
            await server.stop();
        }
    });
});
