/**
 * Serializer interceptor
 *
 * Converts messages to/from JSON, skipping the `grpc.*` service namespace by default.
 *
 * @module serializer
 */

import type { DescMessage, JsonValue, Message } from "@bufbuild/protobuf";
import { fromJson, toJson } from "@bufbuild/protobuf";
import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import type { SerializerOptions } from "./types.ts";

/**
 * Convert stream messages from JSON
 *
 * @param schema - Message schema
 * @param stream - Input stream
 * @param ignoreUnknownFields - Ignore unknown fields
 * @returns Async generator that yields deserialized messages
 */
async function* fromJsonStream<T>(schema: DescMessage, stream: AsyncIterable<unknown>, ignoreUnknownFields: boolean): AsyncGenerator<T, void, void> {
    for await (const message of stream) {
        yield fromJson(schema, message as JsonValue, { ignoreUnknownFields }) as T;
    }
}

/**
 * Convert stream messages to JSON
 *
 * @param schema - Message schema
 * @param stream - Input stream
 * @param alwaysEmitImplicit - Always emit implicit values
 * @returns Async generator that yields serialized messages
 */
async function* toJsonStream<T>(schema: DescMessage, stream: AsyncIterable<T>, alwaysEmitImplicit: boolean): AsyncGenerator<unknown, void, void> {
    for await (const message of stream) {
        yield toJson(schema, message as Message, { alwaysEmitImplicit });
    }
}

/**
 * Create serializer interceptor
 *
 * Automatically serializes/deserializes messages to/from JSON.
 * By default, skips services whose protobuf type name starts with `grpc.`,
 * including the standard Health and Reflection services. This checks the
 * service namespace, regardless of the wire protocol used for the call.
 *
 * @param options - Serializer options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createSerializerInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createSerializerInterceptor({
 *       skipGrpcServices: true,
 *       alwaysEmitImplicit: true,
 *       ignoreUnknownFields: true,
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 *
 * @example Client-side usage with transport
 * ```typescript
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createSerializerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createSerializerInterceptor({ alwaysEmitImplicit: true }),
 *   ],
 * });
 * ```
 */
export function createSerializerInterceptor(options: SerializerOptions = {}): Interceptor {
    const { skipGrpcServices = true, alwaysEmitImplicit = true, ignoreUnknownFields = true } = options;

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        // Skip the grpc.* service namespace, independently of the wire protocol.
        if (skipGrpcServices && req.service.typeName.startsWith("grpc.")) {
            return await next(req);
        }

        // Serialize request to JSON (create new request object with spread)
        const modifiedReq = req.stream
            ? { ...req, message: toJsonStream(req.method.input, req.message, alwaysEmitImplicit) }
            : {
                  ...req,
                  message: toJson(req.method.input, req.message as Message, {
                      alwaysEmitImplicit,
                  }),
              };

        // Execute request and deserialize response (cast needed: message is transformed from protobuf to JSON)
        const res = await next(modifiedReq as UnaryRequest | StreamRequest);

        // Apply the same namespace exclusion to the response.
        if (skipGrpcServices && res.service.typeName.startsWith("grpc.")) {
            return res;
        }

        // Deserialize response from JSON (create new response object with spread)
        if (res.stream) {
            return { ...res, message: fromJsonStream(res.method.output, res.message, ignoreUnknownFields) };
        }
        return {
            ...res,
            message: fromJson(res.method.output, res.message as unknown as JsonValue, {
                ignoreUnknownFields,
            }),
        };
    };
}
