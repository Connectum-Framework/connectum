/**
 * Logger interceptor
 *
 * Logs all RPC requests and responses for debugging.
 *
 * @module logger
 */

import type { DescMessage, Message } from "@bufbuild/protobuf";
import { toJson } from "@bufbuild/protobuf";
import type { Interceptor, StreamRequest, StreamResponse, UnaryRequest } from "@connectrpc/connect";
import type { LoggerOptions } from "./types.ts";

/**
 * Log request stream messages
 *
 * @param stream - Input stream
 * @param msg - Log message prefix
 * @param logger - Logger function
 * @returns Async generator that yields messages
 */
async function* logReqStream<T>(stream: AsyncIterable<T>, msg: string, logger: (message: string, ...args: unknown[]) => void): AsyncGenerator<T, void, void> {
    for await (const message of stream) {
        logger(`${msg} request`, message);
        yield message;
    }
}

/**
 * Log response stream messages
 *
 * @param schema - Message schema
 * @param stream - Output stream
 * @param msg - Log message prefix
 * @param logger - Logger function
 * @returns Async generator that yields messages
 */
async function* logResStream<T>(schema: DescMessage, stream: AsyncIterable<T>, msg: string, logger: (message: string, ...args: unknown[]) => void): AsyncGenerator<T, void, void> {
    for await (const message of stream) {
        logger(`${msg} response`, toJson(schema, message as Message));
        yield message;
    }
}

/**
 * Create logger interceptor
 *
 * Logs all RPC requests and responses with timing information.
 * Supports both unary and streaming RPCs.
 *
 * @param options - Logger options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createLoggerInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createLoggerInterceptor({
 *       level: 'debug',
 *       skipHealthCheck: true,
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
 * import { createLoggerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   interceptors: [
 *     createLoggerInterceptor({ level: 'debug' }),
 *   ],
 * });
 * ```
 */
export function createLoggerInterceptor(options: LoggerOptions = {}): Interceptor {
    const { level = "debug", skipHealthCheck = true } = options;
    const logger = options.logger ?? console[level];

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const path = new URL(req.url).pathname;

        // Skip health check services
        if (skipHealthCheck && req.service.typeName.includes("grpc.health")) {
            return await next(req);
        }

        const startTime = performance.now();

        try {
            // Log request (do NOT mutate req.message - it's readonly!)
            if (req.stream) {
                // Wrap stream with logging generator and create new request
                const modifiedReq = { ...req, message: logReqStream(req.message, `STREAM ${path}`, logger) };
                const res = await next(modifiedReq);

                // Wrap response stream with logging generator
                return { ...res, message: logResStream(res.method.output, res.message as AsyncIterable<Message>, `STREAM ${path}`, logger) } as StreamResponse;
            }
            // Log unary request
            logger(`RPC ${path} request`, req.message);

            // Execute request
            const res = await next(req);

            // Log unary response
            logger(`RPC ${path} response`, res.message);

            return res;
        } finally {
            const duration = (performance.now() - startTime).toFixed(2);
            logger(`RPC ${path} completed in ${duration}ms`);
        }
    };
}
