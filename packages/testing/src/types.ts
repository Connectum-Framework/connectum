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
}
