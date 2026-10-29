/**
 * gRPC Server Reflection Protocol handlers (v1 and v1alpha).
 *
 * Both versions share one request handler: their messages are identical apart
 * from the package name. Errors about a single request are answered with an
 * `error_response` and the stream stays open, so a client can keep using it;
 * the protocol asks for "either an error code or an answer" per request.
 *
 * @module @connectum/reflection/serverReflection
 */

import { create } from "@bufbuild/protobuf";
import { Code, type ConnectRouter } from "@connectrpc/connect";
import { ServerReflectionResponseSchema as V1ResponseSchema, ServerReflection as V1ServerReflection } from "#gen/grpc/reflection/v1/reflection_pb.js";
// biome-ignore lint/suspicious/noDeprecatedImports: the v1alpha reflection service is deprecated upstream but still spoken by older gRPC clients and servers, so it is served and used on purpose.
import { ServerReflectionResponseSchema as V1alphaResponseSchema, ServerReflection as V1alphaServerReflection } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import type { DescriptorPool } from "./descriptorPool.ts";

/** The `message_request` oneof of either protocol version. */
export type ReflectionQuery =
    | { case: "fileByFilename" | "fileContainingSymbol" | "allExtensionNumbersOfType" | "listServices"; value: string }
    | { case: "fileContainingExtension"; value: { containingType: string; extensionNumber: number } }
    | { case: undefined; value?: undefined };

/** The `message_response` oneof of either protocol version. */
export type ReflectionAnswer =
    | { case: "fileDescriptorResponse"; value: { fileDescriptorProto: Uint8Array[] } }
    | { case: "allExtensionNumbersResponse"; value: { baseTypeName: string; extensionNumber: number[] } }
    | { case: "listServicesResponse"; value: { service: Array<{ name: string }> } }
    | { case: "errorResponse"; value: { errorCode: number; errorMessage: string } };

function error(code: Code, message: string): ReflectionAnswer {
    return { case: "errorResponse", value: { errorCode: code, errorMessage: message } };
}

/**
 * Largest request message the reflection services read, in bytes. A request
 * carries a file name, a symbol or a type name; no schema has one anywhere
 * near this long. Without a limit of its own a request would be read up to the
 * server-wide `readMaxBytes`, which is about 4 GiB unless the application
 * lowers it. Applies to each message of a stream.
 */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Longest part of a requested name that an error message repeats. The whole
 * request is already echoed in `original_request`; repeating the name in the
 * message as well would double the response for a name nobody can use.
 */
const MAX_ECHOED_NAME_LENGTH = 128;

/**
 * Cut a client-supplied name to {@link MAX_ECHOED_NAME_LENGTH} UTF-16 code
 * units for use in a message, marking the cut with an ellipsis. A name that
 * fits is returned unchanged. A cut never leaves half of a surrogate pair.
 */
function boundedName(name: string): string {
    if (name.length <= MAX_ECHOED_NAME_LENGTH) {
        return name;
    }
    let end = MAX_ECHOED_NAME_LENGTH;
    const last = name.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
    }
    return `${name.slice(0, end)}…`;
}

/**
 * Answer one reflection request.
 *
 * @param pool - Descriptors of the server
 * @param query - The request's `message_request`
 * @param sent - Files already sent on this stream; updated with the files of
 *   this answer
 */
export function answerReflectionQuery(pool: DescriptorPool, query: ReflectionQuery, sent: Set<string>): ReflectionAnswer {
    switch (query.case) {
        case "listServices":
            // "The content will not be checked." — reflection.proto
            return { case: "listServicesResponse", value: { service: pool.services.map((name) => ({ name })) } };
        case "fileByFilename": {
            const file = pool.fileByName(query.value);
            return file === undefined
                ? error(Code.NotFound, `file not found: "${boundedName(query.value)}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "fileContainingSymbol": {
            const file = pool.fileContainingSymbol(query.value);
            return file === undefined
                ? error(Code.NotFound, `symbol not found: "${boundedName(query.value)}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "fileContainingExtension": {
            const { containingType, extensionNumber } = query.value;
            const file = pool.fileContainingExtension(containingType, extensionNumber);
            return file === undefined
                ? error(Code.NotFound, `extension not found: number ${extensionNumber} of message type "${boundedName(containingType)}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "allExtensionNumbersOfType": {
            const numbers = pool.extensionNumbersOf(query.value);
            return numbers === undefined
                ? error(Code.NotFound, `message type not found: "${boundedName(query.value)}"`)
                : { case: "allExtensionNumbersResponse", value: { baseTypeName: query.value, extensionNumber: numbers } };
        }
        case undefined:
            return error(
                Code.InvalidArgument,
                "request has no message_request: set one of file_by_filename, file_containing_symbol, file_containing_extension, all_extension_numbers_of_type, list_services",
            );
    }
}

/**
 * Register `grpc.reflection.v1.ServerReflection` and
 * `grpc.reflection.v1alpha.ServerReflection` on `router`, both answering from
 * `pool`. Each stream tracks the files it has already sent, so overlapping
 * requests on one stream do not resend shared imports. Both read at most
 * {@link MAX_REQUEST_BYTES} per request message.
 */
export function registerServerReflection(router: ConnectRouter, pool: DescriptorPool): void {
    router.service(
        V1ServerReflection,
        {
            async *serverReflectionInfo(requests) {
                const sent = new Set<string>();
                for await (const request of requests) {
                    yield create(V1ResponseSchema, {
                        validHost: request.host,
                        originalRequest: request,
                        messageResponse: answerReflectionQuery(pool, request.messageRequest, sent),
                    });
                }
            },
        },
        { readMaxBytes: MAX_REQUEST_BYTES },
    );
    router.service(
        V1alphaServerReflection,
        {
            async *serverReflectionInfo(requests) {
                const sent = new Set<string>();
                for await (const request of requests) {
                    yield create(V1alphaResponseSchema, {
                        validHost: request.host,
                        originalRequest: request,
                        messageResponse: answerReflectionQuery(pool, request.messageRequest, sent),
                    });
                }
            },
        },
        { readMaxBytes: MAX_REQUEST_BYTES },
    );
}
