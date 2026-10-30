/**
 * Test server utilities for integration testing.
 *
 * Provides {@link createTestServer} to spin up a real gRPC server on a random port
 * and {@link withTestServer} for automatic lifecycle management.
 *
 * @module test-server
 */

import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer } from "@connectum/core";
import type { CreateTestServerOptions, TestServer } from "./types.ts";
import { validateTestServerOptions } from "./validateTestServerOptions.ts";

/** Loopback only: the server has no authentication and its client runs in the same process. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * The host a client uses to reach a server bound to `host`: the bound address
 * itself, except that the wildcard addresses and the default loopback address
 * are reached as `localhost`.
 */
function clientHost(host: string): string {
    if (host === DEFAULT_HOST || host === "0.0.0.0" || host === "::") {
        return "localhost";
    }
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Create and start a test server on a random (or specified) port.
 *
 * Returns a {@link TestServer} with a pre-configured gRPC transport
 * ready for use with ConnectRPC clients. The caller is responsible
 * for calling {@link TestServer.close} when done.
 *
 * The server listens on `127.0.0.1` unless `options.host` says otherwise.
 * {@link TestServer.close} waits up to `options.shutdown.timeout` (30 s by
 * default) for calls that have not finished.
 *
 * @param options - Server configuration (services, interceptors, protocols, port, host, shutdown)
 * @returns Running test server with transport and cleanup function
 *
 * @example
 * ```typescript
 * const server = await createTestServer({ services: [myRoutes] });
 * const client = createClient(MyService, server.transport);
 * const response = await client.myMethod({ id: "1" });
 * await server.close();
 * ```
 */
export async function createTestServer(options: CreateTestServerOptions): Promise<TestServer> {
    validateTestServerOptions(options);
    const host = options.host ?? DEFAULT_HOST;

    const server = createServer({
        services: options.services,
        port: options.port ?? 0,
        host,
        protocols: [...(options.protocols ?? [])],
        interceptors: [...(options.interceptors ?? [])],
        ...(options.shutdown?.timeout !== undefined ? { shutdown: { timeout: options.shutdown.timeout } } : {}),
        allowHTTP1: false,
    });

    await server.start();

    let port: number;
    try {
        const assignedPort = server.address?.port;
        if (!assignedPort) {
            throw new Error("Server started but no port was assigned");
        }
        port = assignedPort;
    } catch (err) {
        await server.stop();
        throw err;
    }

    const baseUrl = `http://${clientHost(host)}:${port}`;

    const transport = createGrpcTransport({
        baseUrl,
    });

    return {
        transport,
        baseUrl,
        port,
        close: async () => {
            await server.stop();
        },
    };
}

/**
 * Run a test function with an auto-managed test server.
 *
 * Creates a test server, passes it to `testFn`, and guarantees
 * cleanup via `finally` — even if the test throws.
 *
 * @param options - Server configuration (services, interceptors, protocols, port)
 * @param testFn - Async function that receives the running test server
 * @returns The value returned by testFn
 *
 * @example
 * ```typescript
 * const result = await withTestServer({ services: [myRoutes] }, async (server) => {
 *   const client = createClient(MyService, server.transport);
 *   return client.myMethod({ id: "1" });
 * });
 * ```
 */
export async function withTestServer<T>(options: CreateTestServerOptions, testFn: (server: TestServer) => Promise<T>): Promise<T> {
    const server = await createTestServer(options);
    try {
        return await testFn(server);
    } finally {
        await server.close();
    }
}
