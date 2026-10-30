/**
 * Type definitions for @connectum/testing.
 *
 * Mock/fixture option types live in `@connectum/test-fixtures` and are
 * re-exported from this module for backwards compatibility.
 *
 * @module
 */

import type { Interceptor } from "@connectrpc/connect";
import type { ProtocolRegistration, ServiceDefinition } from "@connectum/core";

export type {
    FakeMethodOptions,
    FakeServiceOptions,
    MockDescFieldOptions,
    MockDescMessageOptions,
    MockDescMethodOptions,
    MockNextOptions,
    MockRequestOptions,
    MockStreamOptions,
} from "@connectum/test-fixtures/types";

// ============================================================
// Test Server
// ============================================================

/** A running test server with transport and cleanup. */
export interface TestServer {
    /** Pre-configured client transport connected to the test server. */
    transport: import("@connectrpc/connect").Transport;
    /** Server base URL (e.g. `http://localhost:54321`). */
    baseUrl: string;
    /** Assigned port number. */
    port: number;
    /** Stop the server and close all connections. */
    close(): Promise<void>;
}

/**
 * Options for {@link index.createTestServer | createTestServer}.
 *
 * The element types are those of `createServer()`; a value of another type is
 * a compile error, and in untyped code `createTestServer()` rejects it with a
 * `TypeError` that names the option and the index of the element.
 */
export interface CreateTestServerOptions {
    /** Services to serve, as `defineService()` and `defineLazyService()` return them. */
    services: readonly ServiceDefinition[];
    /** Interceptors to apply. Default: `[]` */
    interceptors?: readonly Interceptor[];
    /** Protocol extensions (Healthcheck, Reflection). Default: `[]` */
    protocols?: readonly ProtocolRegistration[];
    /** Port number. Default: `0` (random available port) */
    port?: number;
    /**
     * Address to listen on, a non-empty string. Default: `127.0.0.1`, so the
     * server is reachable from this machine only: the server has no
     * authentication, and the transport this helper returns runs in the same
     * process. Pass `0.0.0.0` (or `::`) to listen on all interfaces, for a test
     * that reaches the server from another container or host.
     *
     * `baseUrl` points at the address that was bound; a wildcard or the default
     * loopback address is reached as `localhost`. An IPv6 literal other than the
     * `::` wildcard (such as `::1`) is not usable on Node.js: the HTTP/2 client
     * sends the authority without brackets and the server fails to parse it
     * (observed on Node.js 26.12.1; Bun serves it). Use `127.0.0.1`, a host name
     * or `::`.
     */
    host?: string;
    /**
     * Graceful shutdown of `close()`. Only `timeout` is offered: the longest wait,
     * in milliseconds (an integer from 0), for calls still in flight. A unary
     * handler that does not observe `ctx.signal` keeps `close()` waiting until
     * the timeout, 30 s by default, so a test with a handler that can hang sets
     * a short one. When it expires the remaining connections are closed and the
     * unfinished calls fail on the client.
     */
    shutdown?: { timeout?: number };
}
