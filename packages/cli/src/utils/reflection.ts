/**
 * Reflection client utilities
 *
 * Wraps @lambdalisue/connectrpc-grpcreflect ServerReflectionClient
 * for use in CLI commands.
 *
 * @module utils/reflection
 */

import type { FileRegistry } from "@bufbuild/protobuf";
import { create, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ServerReflectionClient } from "@lambdalisue/connectrpc-grpcreflect/client";

/**
 * Result of fetching proto descriptors from a running server.
 */
export interface ReflectionResult {
    /** List of fully-qualified service names */
    services: string[];
    /** FileRegistry containing all discovered file descriptors */
    registry: FileRegistry;
    /** Proto file names in the registry */
    fileNames: string[];
}

/**
 * Fetch service and file descriptor information from a running server via reflection.
 *
 * Uses gRPC Server Reflection Protocol (v1 with v1alpha fallback).
 *
 * @param url - Server URL (e.g., "http://localhost:5000")
 * @returns ReflectionResult with services, registry, and file names
 *
 * @example
 * ```typescript
 * const result = await fetchReflectionData("http://localhost:5000");
 * console.log(result.services); // ["grpc.health.v1.Health", ...]
 * ```
 */
export async function fetchReflectionData(url: string): Promise<ReflectionResult> {
    const transport = createGrpcTransport({ baseUrl: url });
    const client = new ServerReflectionClient(transport);

    try {
        const services = await client.listServices();
        const registry = await client.buildFileRegistry();
        const fileNames = [...registry.files].map((f) => f.name);

        return { services, registry, fileNames };
    } finally {
        await client.close();
    }
}

/**
 * Fetch FileDescriptorSet as binary (.binpb) from a running server via reflection.
 *
 * The binary output can be passed directly to `buf generate` as input.
 *
 * @param url - Server URL (e.g., "http://localhost:5000")
 * @returns Binary FileDescriptorSet (.binpb format)
 *
 * @example
 * ```typescript
 * const binpb = await fetchFileDescriptorSetBinary("http://localhost:5000");
 * writeFileSync("/tmp/descriptors.binpb", binpb);
 * // Then: buf generate /tmp/descriptors.binpb --output ./gen
 * ```
 */
export async function fetchFileDescriptorSetBinary(url: string): Promise<Uint8Array> {
    const transport = createGrpcTransport({ baseUrl: url });
    const client = new ServerReflectionClient(transport);

    try {
        const registry = await client.buildFileRegistry();
        const fileDescriptorSet = create(FileDescriptorSetSchema, {
            file: [...registry.files].map((f) => f.proto),
        });

        return toBinary(FileDescriptorSetSchema, fileDescriptorSet);
    } finally {
        await client.close();
    }
}
