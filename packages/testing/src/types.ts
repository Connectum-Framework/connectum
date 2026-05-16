/**
 * Type definitions for @connectum/testing.
 *
 * Mock/fixture option types live in `@connectum/test-fixtures` and are
 * re-exported from this module for backwards compatibility.
 *
 * @module
 */

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

/** Options for {@link createTestServer}. */
export interface CreateTestServerOptions {
    /** ConnectRPC service route handlers. */
    services: unknown[];
    /** Interceptors to apply. Default: `[]` */
    interceptors?: unknown[];
    /** Protocol extensions (Healthcheck, Reflection). Default: `[]` */
    protocols?: unknown[];
    /** Port number. Default: `0` (random available port) */
    port?: number;
}
