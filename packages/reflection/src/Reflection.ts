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
import type { ProtocolContext, ProtocolRegistration } from "@connectum/core";
import { file_grpc_reflection_v1_reflection } from "#gen/grpc/reflection/v1/reflection_pb.js";
// biome-ignore lint/suspicious/noDeprecatedImports: the v1alpha reflection service is deprecated upstream but still served on purpose, so its schema is described like the others.
import { file_grpc_reflection_v1alpha_reflection } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { createDescriptorPool, type DescriptorPool } from "./descriptorPool.ts";
import { REFLECTION_SERVICES, registerServerReflection } from "./serverReflection.ts";
import { collectFileProtos } from "./utils.ts";

/**
 * Create reflection protocol registration
 *
 * Returns a ProtocolRegistration that implements gRPC Server Reflection
 * Protocol (v1 + v1alpha). Pass it to createServer({ protocols: [...] }).
 *
 * The listing contains every service the server mounts: the application
 * services and the services of all other protocols, wherever `Reflection()`
 * stands in the `protocols` array. The descriptors are collected in the
 * protocol's `ready` hook, after every protocol has registered. The reflection
 * services themselves are not listed, but their schema can be requested like
 * any other: `file_containing_symbol` for `grpc.reflection.v1.ServerReflection`
 * (or its `v1alpha` twin, a method or a message of it) answers with
 * `grpc/reflection/v1/reflection.proto`. File answers carry the requested file
 * and its transitive imports, without repeating files already sent on the same
 * stream.
 *
 * The returned registration holds the descriptors of the server it was
 * set up for, so each server needs its own `Reflection()` call: a shared
 * instance would list the services of whichever server ran `ready` last.
 *
 * A protocol that wraps `Reflection()` and delegates to it must forward
 * `ready` as well as `setup` and `register`. Without `ready` the listing falls
 * back to the services registered before the wrapper, as it did before the
 * hook existed.
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
    // Replaced by `setup` and `ready`. The default is the "never set up" answer,
    // so `register` and a request that bypassed it fail the same way.
    const notSetUp = (): never => {
        // An empty listing would be indistinguishable from "no services".
        throw new Error("Reflection: register() called before setup(); the server must call setup() first.");
    };
    // The descriptors of this server, built once and shared by every router, so
    // the HTTP and in-process listings are identical.
    let currentPool: () => DescriptorPool = notSetUp;

    const ownTypeNames = new Set<string>(REFLECTION_SERVICES.map((service) => service.typeName));

    function build(context: ProtocolContext): DescriptorPool {
        return createDescriptorPool({
            // The services of the two reflection versions are mounted on every router but
            // may not be in the snapshot (`setup` takes it before they register). Their
            // files are added so that a client can describe the reflection service it is
            // talking to; the listing still leaves them out.
            files: collectFileProtos([...context.registry, file_grpc_reflection_v1_reflection, file_grpc_reflection_v1alpha_reflection]),
            services: context.services.map((service) => service.typeName).filter((typeName) => !ownTypeNames.has(typeName)),
        });
    }

    return {
        name: "reflection",

        // Used only when `ready` never runs (a wrapper that does not forward it):
        // the pool is then built from this snapshot on the first request.
        setup(context: ProtocolContext): void {
            let pool: DescriptorPool | undefined;
            currentPool = () => {
                pool ??= build(context);
                return pool;
            };
        },

        // Runs after every protocol has registered, so the listing does not
        // depend on where Reflection() stands in the `protocols` array.
        ready(context: ProtocolContext): void {
            const pool = build(context);
            currentPool = () => pool;
        },

        register(router: ConnectRouter): void {
            if (currentPool === notSetUp) {
                notSetUp();
            }
            // Read per request: the routes are registered before `ready` has built the pool.
            registerServerReflection(router, () => currentPool());
        },
    };
}
