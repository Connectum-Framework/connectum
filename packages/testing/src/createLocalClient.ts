/**
 * Thin wrapper over {@link Server.localClient} for ergonomic test usage.
 *
 * This helper exists primarily for symmetry with {@link createTestServer}
 * and to keep tests independent of `@connectum/core` internals — they can
 * `import { createLocalClient } from "@connectum/testing"` and get a working
 * in-process client without having to know about the `Server.localClient`
 * method or `createLocalTransport`.
 *
 * Unlike `createTestServer`, no HTTP/2 socket is opened: the call goes
 * straight through the in-memory router transport.
 *
 * @module createLocalClient
 */

import type { DescService } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import type { Server } from "@connectum/core";

/**
 * Create an in-process ConnectRPC client for a service registered on the given Server.
 *
 * @param server - A server created via `createServer({...})`. Does not need to be started.
 * @param service - The proto service descriptor (e.g. `GreeterService`).
 * @returns A typed ConnectRPC `Client<T>` that invokes handlers via the in-memory pipe.
 *
 * @example
 * ```typescript
 * import { createServer } from "@connectum/core";
 * import { createLocalClient } from "@connectum/testing";
 *
 * const server = createServer({ services: [greeterRoutes] });
 * const client = createLocalClient(server, GreeterService);
 * const res = await client.sayHello({ name: "world" });
 * ```
 */
export function createLocalClient<T extends DescService>(server: Server, service: T): Client<T> {
    return server.localClient(service);
}
