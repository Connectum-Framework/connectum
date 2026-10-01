/**
 * Reflection client utilities
 *
 * A gRPC Server Reflection Protocol client for CLI commands. It speaks v1 and
 * falls back to v1alpha for servers that only implement the older version.
 *
 * @module utils/reflection
 */

import type { FileRegistry, MessageInitShape } from "@bufbuild/protobuf";
import { create, createFileRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type FileDescriptorProto, FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
    ServerReflectionRequestSchema,
    type ServerReflectionResponse,
    ServerReflectionResponseSchema,
    ServerReflection as V1ServerReflection,
} from "#gen/grpc/reflection/v1/reflection_pb.js";
import {
    ServerReflectionRequestSchema as V1alphaRequestSchema,
    ServerReflectionResponseSchema as V1alphaResponseSchema,
    ServerReflection as V1alphaServerReflection,
} from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { reflectionErrorCode } from "./reflectionErrorCode.ts";

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

type Query = NonNullable<MessageInitShape<typeof ServerReflectionRequestSchema>["messageRequest"]>;

/** Sends one reflection request and returns the answer, as a v1 message. */
type Ask = (query: Query) => Promise<ServerReflectionResponse>;

async function* once<T>(item: T): AsyncIterable<T> {
    yield item;
}

async function first<T>(responses: AsyncIterable<T>): Promise<T> {
    for await (const response of responses) {
        return response;
    }
    throw new ConnectError("reflection stream closed without a response", Code.Internal);
}

/**
 * One request per stream: the server may omit files it already sent on a
 * stream, and a fresh stream guarantees every answer carries what it needs.
 */
function askV1(transport: Transport): Ask {
    const client = createClient(V1ServerReflection, transport);
    return (messageRequest) => first(client.serverReflectionInfo(once(create(ServerReflectionRequestSchema, { messageRequest }))));
}

/** v1alpha messages are wire-identical to v1; convert through their binary form. */
function askV1alpha(transport: Transport): Ask {
    const client = createClient(V1alphaServerReflection, transport);
    return async (messageRequest) => {
        const request = fromBinary(V1alphaRequestSchema, toBinary(ServerReflectionRequestSchema, create(ServerReflectionRequestSchema, { messageRequest })));
        const response = await first(client.serverReflectionInfo(once(request)));
        return fromBinary(ServerReflectionResponseSchema, toBinary(V1alphaResponseSchema, response));
    };
}

function errorOf(response: ServerReflectionResponse): ConnectError {
    if (response.messageResponse.case === "errorResponse") {
        const { errorCode, errorMessage } = response.messageResponse.value;
        return new ConnectError(errorMessage, reflectionErrorCode(errorCode));
    }
    return new ConnectError(`unexpected reflection response: ${response.messageResponse.case ?? "empty"}`, Code.Internal);
}

async function listServices(ask: Ask): Promise<string[]> {
    const response = await ask({ case: "listServices", value: "" });
    if (response.messageResponse.case !== "listServicesResponse") {
        throw errorOf(response);
    }
    return response.messageResponse.value.service.map((service) => service.name);
}

function decodeFiles(response: ServerReflectionResponse): FileDescriptorProto[] {
    return response.messageResponse.case === "fileDescriptorResponse"
        ? response.messageResponse.value.fileDescriptorProto.map((bytes) => fromBinary(FileDescriptorProtoSchema, bytes))
        : [];
}

/**
 * Detect the protocol version and list the services: v1 first, v1alpha when
 * the server does not implement v1.
 */
async function connect(transport: Transport): Promise<{ ask: Ask; services: string[] }> {
    const v1 = askV1(transport);
    try {
        return { ask: v1, services: await listServices(v1) };
    } catch (v1Error) {
        if (!(v1Error instanceof ConnectError && v1Error.code === Code.Unimplemented)) {
            throw v1Error;
        }
        const v1alpha = askV1alpha(transport);
        try {
            return { ask: v1alpha, services: await listServices(v1alpha) };
        } catch (v1alphaError) {
            throw new Error(
                `Both reflection v1 and v1alpha failed. v1 error: ${v1Error.message}, v1alpha error: ${v1alphaError instanceof Error ? v1alphaError.message : String(v1alphaError)}`,
            );
        }
    }
}

/**
 * Build a FileRegistry from the files of every listed service.
 *
 * Files are ordered depth-first with every file after its imports, starting
 * from each service's file in listing order — the order `proto sync` emits.
 * Imports missing from an answer are fetched by name.
 */
async function buildFileRegistry(ask: Ask, services: string[]): Promise<FileRegistry> {
    const received = new Map<string, FileDescriptorProto>();
    const ordered = new Map<string, FileDescriptorProto>();

    const remember = (files: FileDescriptorProto[]): void => {
        for (const file of files) {
            if (!received.has(file.name)) {
                received.set(file.name, file);
            }
        }
    };

    const fetchByName = async (name: string): Promise<FileDescriptorProto> => {
        const known = received.get(name);
        if (known !== undefined) {
            return known;
        }
        const response = await ask({ case: "fileByFilename", value: name });
        const files = decodeFiles(response);
        const [file] = files;
        if (file === undefined) {
            throw response.messageResponse.case === "errorResponse" ? errorOf(response) : new ConnectError(`file not found: ${name}`, Code.NotFound);
        }
        remember(files);
        return file;
    };

    const visit = async (file: FileDescriptorProto): Promise<void> => {
        for (const dependency of file.dependency) {
            if (!ordered.has(dependency)) {
                await visit(await fetchByName(dependency));
            }
        }
        if (file.name && !ordered.has(file.name)) {
            ordered.set(file.name, file);
        }
    };

    for (const service of services) {
        // A service the server lists but cannot resolve contributes no files.
        const files = decodeFiles(await ask({ case: "fileContainingSymbol", value: service }));
        remember(files);
        const [serviceFile] = files;
        if (serviceFile !== undefined && !ordered.has(serviceFile.name)) {
            await visit(serviceFile);
        }
    }

    return createFileRegistry(create(FileDescriptorSetSchema, { file: [...ordered.values()] }));
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
    const { ask, services } = await connect(createGrpcTransport({ baseUrl: url }));
    const registry = await buildFileRegistry(ask, services);
    const fileNames = [...registry.files].map((f) => f.name);

    return { services, registry, fileNames };
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
    const { ask, services } = await connect(createGrpcTransport({ baseUrl: url }));
    const registry = await buildFileRegistry(ask, services);
    const fileDescriptorSet = create(FileDescriptorSetSchema, {
        file: [...registry.files].map((f) => f.proto),
    });

    return toBinary(FileDescriptorSetSchema, fileDescriptorSet);
}
