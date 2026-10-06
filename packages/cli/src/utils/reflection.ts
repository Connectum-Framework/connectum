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
    // biome-ignore lint/suspicious/noDeprecatedImports: v1alpha is deprecated upstream but is the only reflection version older servers implement, so it is the fallback on purpose.
    ServerReflectionRequestSchema as V1alphaRequestSchema,
    // biome-ignore lint/suspicious/noDeprecatedImports: v1alpha is deprecated upstream but is the only reflection version older servers implement, so it is the fallback on purpose.
    ServerReflectionResponseSchema as V1alphaResponseSchema,
    // biome-ignore lint/suspicious/noDeprecatedImports: v1alpha is deprecated upstream but is the only reflection version older servers implement, so it is the fallback on purpose.
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

/** Time limit of one reflection request when the caller sets none. A design choice, not a measurement. */
export const DEFAULT_REFLECTION_TIMEOUT_MS = 10_000;

/** Largest value a timer (and therefore a call deadline) can carry; above it the deadline fires at once. */
export const MAX_REFLECTION_TIMEOUT_MS = 2_147_483_647;

/** Options of the reflection fetch. */
export interface ReflectionOptions {
    /** Time limit of each reflection request, in milliseconds (default {@link DEFAULT_REFLECTION_TIMEOUT_MS}). */
    timeoutMs?: number | undefined;
}

/** Whether `value` is a time limit the reflection client accepts. */
export function isValidReflectionTimeout(value: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= MAX_REFLECTION_TIMEOUT_MS;
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
function askV1(transport: Transport, timeoutMs: number): Ask {
    const client = createClient(V1ServerReflection, transport);
    return (messageRequest) => first(client.serverReflectionInfo(once(create(ServerReflectionRequestSchema, { messageRequest })), { timeoutMs }));
}

/** v1alpha messages are wire-identical to v1; convert through their binary form. */
function askV1alpha(transport: Transport, timeoutMs: number): Ask {
    const client = createClient(V1alphaServerReflection, transport);
    return async (messageRequest) => {
        const request = fromBinary(V1alphaRequestSchema, toBinary(ServerReflectionRequestSchema, create(ServerReflectionRequestSchema, { messageRequest })));
        const response = await first(client.serverReflectionInfo(once(request), { timeoutMs }));
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
async function connect(transport: Transport, timeoutMs: number): Promise<{ ask: Ask; services: string[] }> {
    const v1 = askV1(transport, timeoutMs);
    try {
        return { ask: v1, services: await listServices(v1) };
    } catch (v1Error) {
        if (!(v1Error instanceof ConnectError && v1Error.code === Code.Unimplemented)) {
            throw v1Error;
        }
        const v1alpha = askV1alpha(transport, timeoutMs);
        try {
            return { ask: v1alpha, services: await listServices(v1alpha) };
        } catch (v1alphaError) {
            // A time limit is not a protocol-version mismatch: report it as such, not as "both failed".
            if (v1alphaError instanceof ConnectError && v1alphaError.code === Code.DeadlineExceeded) {
                throw v1alphaError;
            }
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
        // A service the server lists but cannot resolve contributes no files; the completeness
        // check in `loadRegistry` turns that into an error naming it.
        const files = decodeFiles(await ask({ case: "fileContainingSymbol", value: service }));
        remember(files);
        const [serviceFile] = files;
        if (serviceFile !== undefined && !ordered.has(serviceFile.name)) {
            await visit(serviceFile);
        }
    }

    return createFileRegistry(create(FileDescriptorSetSchema, { file: [...ordered.values()] }));
}

/** Message for a request that ran into its time limit, naming the server and the limit. */
function timeoutError(url: string, timeoutMs: number, cause: ConnectError): Error {
    return new Error(
        `Reflection request to ${url} timed out after ${timeoutMs} ms (${cause.rawMessage}). Check that the address is a gRPC server with reflection, or raise --timeout.`,
        { cause },
    );
}

/**
 * Connect, list the services and build the registry, failing unless every listed service
 * has a descriptor in it. The one path shared by the full sync and the dry run, so neither
 * can report success on a partial result.
 */
async function loadRegistry(url: string, options: ReflectionOptions): Promise<{ services: string[]; registry: FileRegistry }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
    if (!isValidReflectionTimeout(timeoutMs)) {
        throw new Error(`The reflection time limit must be an integer from 1 to ${MAX_REFLECTION_TIMEOUT_MS} ms, got ${timeoutMs}.`);
    }
    try {
        const { ask, services } = await connect(createGrpcTransport({ baseUrl: url }), timeoutMs);
        const registry = await buildFileRegistry(ask, services);
        const unresolved = services.filter((service) => registry.getService(service) === undefined);
        if (unresolved.length > 0) {
            throw new Error(
                `${url} lists ${services.length} service(s) but reflection returned no descriptor for ${unresolved.length} of them: ${unresolved.join(", ")}. Nothing was generated.`,
            );
        }
        return { services, registry };
    } catch (error) {
        if (error instanceof ConnectError && error.code === Code.DeadlineExceeded) {
            throw timeoutError(url, timeoutMs, error);
        }
        throw error;
    }
}

/**
 * Fetch service and file descriptor information from a running server via reflection.
 *
 * Uses gRPC Server Reflection Protocol (v1 with v1alpha fallback). Fails, naming them,
 * when the server lists a service it cannot describe, and when a request exceeds the time limit.
 *
 * @param url - Server URL (e.g., "http://localhost:5000")
 * @param options - Time limit of each request
 * @returns ReflectionResult with services, registry, and file names
 *
 * @example
 * ```typescript
 * const result = await fetchReflectionData("http://localhost:5000");
 * console.log(result.services); // ["grpc.health.v1.Health", ...]
 * ```
 */
export async function fetchReflectionData(url: string, options: ReflectionOptions = {}): Promise<ReflectionResult> {
    const { services, registry } = await loadRegistry(url, options);
    const fileNames = [...registry.files].map((f) => f.name);

    return { services, registry, fileNames };
}

/**
 * Fetch FileDescriptorSet as binary (.binpb) from a running server via reflection.
 *
 * The binary output can be passed directly to `buf generate` as input. The same completeness
 * and time-limit rules as {@link fetchReflectionData} apply.
 *
 * @param url - Server URL (e.g., "http://localhost:5000")
 * @param options - Time limit of each request
 * @returns Binary FileDescriptorSet (.binpb format)
 *
 * @example
 * ```typescript
 * const binpb = await fetchFileDescriptorSetBinary("http://localhost:5000");
 * writeFileSync(".tmp/descriptors.binpb", binpb);
 * // Then: buf generate .tmp/descriptors.binpb --output ./gen
 * ```
 */
export async function fetchFileDescriptorSetBinary(url: string, options: ReflectionOptions = {}): Promise<Uint8Array> {
    const { registry } = await loadRegistry(url, options);
    const fileDescriptorSet = create(FileDescriptorSetSchema, {
        file: [...registry.files].map((f) => f.proto),
    });

    return toBinary(FileDescriptorSetSchema, fileDescriptorSet);
}
