/**
 * Reflection protocol registration factory
 *
 * Creates a ProtocolRegistration for the gRPC Server Reflection Protocol
 * (v1 + v1alpha).
 *
 * Allows clients (grpcurl, Postman, buf curl) to discover services,
 * methods, and message types at runtime.
 *
 * @module @connectum/reflection/Reflection
 */

import type { ConnectRouter } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import type { ProtocolContext, ProtocolRegistration } from "@connectum/core";
import { createDescriptorPool, type DescriptorPool } from "./descriptorPool.ts";
import { registerServerReflection } from "./serverReflection.ts";
import { collectFileProtos } from "./utils.ts";

/**
 * Create reflection protocol registration
 *
 * Returns a ProtocolRegistration that implements gRPC Server Reflection
 * Protocol (v1 + v1alpha). Pass it to createServer({ protocols: [...] }).
 *
 * The listing contains the services mounted before this protocol: every
 * application service and the protocols that precede `Reflection()` in the
 * `protocols` array. File answers carry the requested file and its transitive
 * imports, without repeating files already sent on the same stream.
 *
 * The returned registration holds the descriptors of the server it was
 * set up for, so each server needs its own `Reflection()` call: a shared
 * instance would list the services of whichever server ran `setup` last.
 *
 * @returns ProtocolRegistration for server reflection
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { Reflection } from '@connectum/reflection';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   protocols: [Reflection()],
 * });
 *
 * await server.start();
 * // Now clients can discover services via gRPC reflection
 * ```
 */
export function Reflection(): ProtocolRegistration {
    // Built once from the registry snapshot and shared by every router, so the
    // HTTP and in-process listings are identical.
    let pool: DescriptorPool | undefined;

    return {
        name: "reflection",

        setup(context: ProtocolContext): void {
            pool = createDescriptorPool({
                files: collectFileProtos(context.registry),
                services: context.services.map((service) => service.typeName),
            });
        },

        register(router: ConnectRouter): void {
            if (pool === undefined) {
                // An empty listing would be indistinguishable from "no services".
                throw new Error("Reflection: register() called before setup(); the server must call setup() first.");
            }
            registerServerReflection(router, pool);
        },
    };
}
