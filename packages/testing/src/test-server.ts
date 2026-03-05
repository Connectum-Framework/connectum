/**
 * Test server utilities for integration testing.
 *
 * Provides {@link createTestServer} to spin up a real gRPC server on a random port
 * and {@link withTestServer} for automatic lifecycle management.
 *
 * @module test-server
 */

import { createGrpcTransport } from "@connectrpc/connect-node";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier, not a relative import
import { createServer } from "@connectum/core";
import type { CreateTestServerOptions, TestServer } from "./types.ts";

/**
 * Create and start a test server on a random (or specified) port.
 *
 * Returns a {@link TestServer} with a pre-configured gRPC transport
 * ready for use with ConnectRPC clients. The caller is responsible
 * for calling {@link TestServer.close} when done.
 *
 * @param options - Server configuration (services, interceptors, protocols, port)
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
    const server = createServer({
        // biome-ignore lint/suspicious/noExplicitAny: bridging generic test types to internal createServer API
        services: options.services as any[],
        port: options.port ?? 0,
        // biome-ignore lint/suspicious/noExplicitAny: bridging generic test types to internal createServer API
        protocols: (options.protocols ?? []) as any[],
        // biome-ignore lint/suspicious/noExplicitAny: bridging generic test types to internal createServer API
        interceptors: (options.interceptors ?? []) as any[],
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

    const baseUrl = `http://localhost:${port}`;

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
 * Creates a test server, passes it to {@link testFn}, and guarantees
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
