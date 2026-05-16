/**
 * Group 6 — HTTP / local coexistence.
 *
 *   6.1 One Server serving HTTP and local clients concurrently; server-side
 *       interceptor observes both invocations.
 *   6.2 Already covered by Phase 1 in
 *       packages/core/tests/integration/localTransport.test.ts
 *       ("server.localClient invokes registered service without start()").
 */

import assert from "node:assert";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { type ConnectRouter, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer } from "@connectum/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

test("coexistence 6.1: one Server serves HTTP and local clients; interceptor observes both", async () => {
    let counter = 0;
    const countingInterceptor: Interceptor = (next) => async (req) => {
        counter++;
        return next(req);
    };

    const routes = (router: ConnectRouter) => {
        router.service(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    };

    const server = createServer({
        services: [routes],
        interceptors: [countingInterceptor],
        port: 0,
        allowHTTP1: false,
    });
    await server.start();

    try {
        const port = server.address?.port;
        assert.ok(port, "HTTP server bound a port");

        // Local client via server.client() (uses in-process transport).
        const localClient = server.client(EchoService);
        const localRes = await localClient.echo(create(EchoRequestSchema, { message: "local" }));
        assert.strictEqual(localRes.message, "echo:local");

        // HTTP client via createGrpcTransport.
        const httpTransport = createGrpcTransport({ baseUrl: `http://localhost:${port}` });
        const httpClient = createClient(EchoService, httpTransport);
        const httpRes = await httpClient.echo(create(EchoRequestSchema, { message: "http" }));
        assert.strictEqual(httpRes.message, "echo:http");

        // Server-side interceptor must have observed both invocations.
        assert.strictEqual(counter, 2, `interceptor counter should be 2, got ${counter}`);
    } finally {
        await server.stop();
    }
});
