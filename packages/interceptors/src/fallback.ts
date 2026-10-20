/**
 * Fallback interceptor
 *
 * Provides graceful degradation when service fails.
 *
 * @module fallback
 */

import type { Interceptor, StreamRequest, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FallbackOptions } from "./types.ts";

/**
 * Whether a failure is a refusal of access. A fallback value stands in for a failed
 * dependency; it must not stand in for a caller who is not allowed.
 */
function isAccessRefusal(err: unknown): boolean {
    const code = ConnectError.from(err).code;
    return code === Code.Unauthenticated || code === Code.PermissionDenied;
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
 * The handler returns the RPC response message, not a response wrapper.
 * In the server example, getCachedData is application code that returns that message.
 *
 * A refusal of access is never replaced: a failure with the code `Unauthenticated` or
 * `PermissionDenied` is rethrown as it is, and the `handler` is not called for it. The
 * fallback value is for failed dependencies, timeouts and bugs, not for callers who are
 * not allowed. Even so, put the authentication and authorization interceptors in front of
 * the default interceptors, as the authentication guide shows.
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
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createFallbackInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createFallbackInterceptor({
 *       handler: () => ({ data: [] }),
 *     }),
 *   ],
 * });
 * ```
 */
export function createFallbackInterceptor<T = unknown>(options: FallbackOptions<T>): Interceptor {
    const { handler, skipStreaming = true } = options;

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
            const fallbackValue = await handler(err as Error);

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
