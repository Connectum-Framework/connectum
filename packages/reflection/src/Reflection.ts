/**
 * Reflection protocol registration factory
 *
 * Creates a ProtocolRegistration for gRPC Server Reflection (v1 + v1alpha)
 * via @lambdalisue/connectrpc-grpcreflect.
 *
 * Allows clients (grpcurl, Postman, buf curl) to discover services,
 * methods, and message types at runtime.
 *
 * @module @connectum/reflection/Reflection
 */

import { create } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";
import type { ProtocolContext, ProtocolRegistration } from "@connectum/core";
import { registerServerReflectionFromFileDescriptorSet } from "@lambdalisue/connectrpc-grpcreflect/server";
import { collectFileProtos } from "./utils.ts";

/**
 * Create reflection protocol registration
 *
 * Returns a ProtocolRegistration that implements gRPC Server Reflection
 * Protocol (v1 + v1alpha). Pass it to createServer({ protocols: [...] }).
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
    return {
        name: "reflection",

        register(router: ConnectRouter, context: ProtocolContext): void {
            const fileDescriptorSet = create(FileDescriptorSetSchema, {
                file: collectFileProtos(context.registry),
            });

            registerServerReflectionFromFileDescriptorSet(router, fileDescriptorSet);
        },
    };
}
