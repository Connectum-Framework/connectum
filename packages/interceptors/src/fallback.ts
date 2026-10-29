/**
 * Fallback interceptor
 *
 * Provides graceful degradation when service fails.
 *
 * @module fallback
 */

import type { DescMessage, Message, MessageInitShape } from "@bufbuild/protobuf";
import { create, isMessage, toBinary } from "@bufbuild/protobuf";
import type { Interceptor, StreamRequest, StreamResponse, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { initProblem, isPlainObject } from "./response-init.ts";
import type { FallbackOptions } from "./types.ts";
import { requireBoolean, requireOptionsObject } from "./validate.ts";

/**
 * Whether a failure is a refusal of access. A fallback value stands in for a failed
 * dependency; it must not stand in for a caller who is not allowed.
 */
function isAccessRefusal(err: unknown): boolean {
    const code = ConnectError.from(err).code;
    return code === Code.Unauthenticated || code === Code.PermissionDenied;
}

/**
 * The response message a fallback handler's value stands for.
 *
 * A value that is already a message of the method's output type is used as it is.
 * A plain object is checked against the type first (`initProblem`), then turned into one with
 * `create`, which is lenient on its own: it drops keys the type does not have and coerces
 * values of the wrong kind (a number in a string field becomes `"5"`). A typo would therefore
 * answer with a wrong or empty message without any signal. Both are refused here, naming the
 * handler, so the mistake is found where it is made.
 */
function toResponseMessage(schema: DescMessage, value: unknown): Message {
    const expected = `createFallbackInterceptor: handler must return a ${schema.typeName} message or a plain object that initialises one`;
    if (isMessage(value, schema)) {
        return value;
    }
    if (!isPlainObject(value)) {
        throw new TypeError(`${expected}, got ${value === null ? "null" : typeof value}`);
    }
    const problem = initProblem(schema, value);
    if (problem !== undefined) {
        throw new TypeError(`${expected}, but ${problem}`);
    }
    try {
        const message = create(schema, value as MessageInitShape<DescMessage>);
        // What the walk above cannot judge (an integer out of its range, NaN) the encoder rejects here, by name.
        toBinary(schema, message);
        return message;
    } catch (cause) {
        throw new TypeError(`${expected}, got an object that cannot be converted: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
}

/** Content types the Connect protocol uses for a GET request, keyed by its `encoding` query parameter. */
const CONNECT_GET_CONTENT_TYPES: Readonly<Record<string, string>> = {
    json: "application/json",
    proto: "application/proto",
};

/**
 * Content type of the response the fallback synthesises: the request `content-type`;
 * for a Connect GET request, which carries none, the one named by its `encoding` query
 * parameter. `null` when neither yields a type, so that no type is guessed.
 */
function responseContentType(req: UnaryRequest | StreamRequest): string | null {
    const contentType = req.header.get("content-type");
    if (contentType) {
        return contentType;
    }
    if (req.requestMethod === "GET") {
        try {
            const encoding = new URL(req.url).searchParams.get("encoding");
            if (encoding !== null && Object.hasOwn(CONNECT_GET_CONTENT_TYPES, encoding)) {
                return CONNECT_GET_CONTENT_TYPES[encoding] ?? null;
            }
        } catch {
            // A request URL that cannot be parsed names no encoding.
        }
    }
    return null;
}

/**
 * Create fallback interceptor
 *
 * Provides fallback response when service fails, enabling graceful degradation.
 * The handler returns the RPC response message, not a response wrapper. It may return a
 * message created for the method's output type (`create(OutputSchema, { ... })`), or a plain
 * object with that message's fields, which the interceptor turns into one. A value that is
 * neither (`undefined`, `null`, a string) fails the call with a `TypeError` that names this
 * interceptor and the expected type. A plain object is checked field by field first: a key that
 * is not a field, a value of another kind than its field takes (a number in a string field, a
 * non-boolean in a bool field, a non-array in a repeated field) and a number the encoder cannot
 * write fail the same way, with the path of the problem; so do a map key that is not in the canonical
 * form of its key type, a non-canonical string for a 64-bit integer, a lone surrogate and bytes that are
 * not a `Uint8Array` or an array of integers 0 to 255. A oneof is set as `{ case, value }`
 * under the oneof's name. Behind the error handler the client sees `Internal: internal error`.
 * In the server example, getCachedData is application code that returns that message.
 *
 * A refusal of access is never replaced: a failure with the code `Unauthenticated` or
 * `PermissionDenied` is rethrown as it is, and the `handler` is not called for it. The
 * fallback value is for failed dependencies, timeouts and bugs, not for callers who are
 * not allowed. Even so, put the authentication and authorization interceptors in front of
 * the default interceptors, as the authentication guide shows.
 *
 * A request rejected by validation is a client error, not a failed dependency, so the
 * validation interceptor must stand outside this one. `createDefaultInterceptors` does so;
 * when you compose the chain yourself, put validation before the fallback, or an invalid
 * request is answered with the fallback value as if it had been served.
 *
 * The response synthesised by the fallback interceptor carries only the protocol
 * headers it needs, on a server chain and on a client transport alike:
 * - `header` holds one field, `content-type`, equal to the request `content-type`
 *   (for a Connect GET request without one, derived from the `encoding` query
 *   parameter: `json` gives `application/json`, `proto` gives `application/proto`;
 *   the header stays empty when no type can be derived).
 * - `trailer` holds `grpc-status: 0` when the request `content-type` starts with
 *   `application/grpc` (gRPC and gRPC-web), and is empty otherwise.
 *
 * No header of the request is copied into the response, whichever interceptor added
 * it, so the response is accepted by Connect, gRPC and gRPC-web clients over HTTP/2
 * and HTTP/1.1 and does not hand request headers back to the caller. Metadata the
 * caller needs belongs in the message the `handler` returns.
 *
 * Streaming calls are skipped by default. With `skipStreaming: false` the fallback covers a
 * streaming call whose opening fails: the `handler`'s message is then the only message of
 * the call (the single response of a client-streaming call). A failure after the response
 * has opened, while its messages are being read, is not replaced.
 *
 * @param options - Fallback options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createFallbackInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createFallbackInterceptor({
 *       handler: (error) => {
 *         console.error('Service failed, returning cached data:', error);
 *         return getCachedData();
 *       },
 *       skipStreaming: true,
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 *
 * @example Client-side usage with transport
 * ```typescript
 * import { create } from '@bufbuild/protobuf';
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createFallbackInterceptor } from '@connectum/interceptors';
 * import { ListItemsResponseSchema } from './gen/items_pb.js';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createFallbackInterceptor({
 *       // A message made with create(), or a plain object with the fields of the response message
 *       handler: () => create(ListItemsResponseSchema, { items: [] }),
 *     }),
 *   ],
 * });
 * ```
 */
export function createFallbackInterceptor<T = unknown>(options: FallbackOptions<T>): Interceptor {
    requireOptionsObject({ caller: "createFallbackInterceptor", value: options });
    const { handler, skipStreaming = true } = options;
    requireBoolean({ caller: "createFallbackInterceptor", option: "skipStreaming", value: skipStreaming });

    // Validate options
    if (typeof handler !== "function") {
        throw new TypeError("createFallbackInterceptor: handler must be a function");
    }

    return (next) => async (req) => {
        // Skip streaming calls
        if (skipStreaming && req.stream) {
            return await next(req);
        }

        try {
            // Execute normally
            return await next(req);
        } catch (err) {
            // A refusal of access (`Unauthenticated`, `PermissionDenied`) reaches the caller as it is,
            // wherever the authentication or authorization interceptor stands in the chain.
            if (isAccessRefusal(err)) {
                throw err;
            }

            // Call fallback handler
            const fallbackValue = toResponseMessage(req.method.output, await handler(err as Error));

            const contentType = responseContentType(req);
            const header = new Headers();
            if (contentType !== null) {
                header.set("content-type", contentType);
            }
            const trailer = new Headers();
            // Media types are case-insensitive, and Connect matches the gRPC content types that way.
            if (contentType?.toLowerCase().startsWith("application/grpc")) {
                trailer.set("grpc-status", "0");
            }

            // A streaming call is answered with a streaming response: the fallback message is its only
            // message (the single response of a client-streaming call). A unary-shaped response for it
            // reaches the caller as `Internal: internal error` with no message.
            if (req.stream) {
                return {
                    stream: true,
                    service: req.service,
                    method: req.method,
                    message: (async function* () {
                        yield fallbackValue;
                    })(),
                    header,
                    trailer,
                } as unknown as StreamResponse;
            }

            return {
                stream: false,
                service: req.service,
                method: req.method,
                message: fallbackValue,
                header,
                trailer,
            } as unknown as UnaryResponse;
        }
    };
}
