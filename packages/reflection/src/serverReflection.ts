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
                ? error(Code.NotFound, `file not found: "${query.value}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "fileContainingSymbol": {
            const file = pool.fileContainingSymbol(query.value);
            return file === undefined
                ? error(Code.NotFound, `symbol not found: "${query.value}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "fileContainingExtension": {
            const { containingType, extensionNumber } = query.value;
            const file = pool.fileContainingExtension(containingType, extensionNumber);
            return file === undefined
                ? error(Code.NotFound, `extension not found: number ${extensionNumber} of message type "${containingType}"`)
                : { case: "fileDescriptorResponse", value: { fileDescriptorProto: pool.withDependencies(file, sent) } };
        }
        case "allExtensionNumbersOfType": {
            const numbers = pool.extensionNumbersOf(query.value);
            return numbers === undefined
                ? error(Code.NotFound, `message type not found: "${query.value}"`)
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
 * requests on one stream do not resend shared imports.
 */
export function registerServerReflection(router: ConnectRouter, pool: DescriptorPool): void {
    router.service(V1ServerReflection, {
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
    });
    router.service(V1alphaServerReflection, {
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
    });
}
