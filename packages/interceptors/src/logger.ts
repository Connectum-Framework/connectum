/**
 * Logger interceptor
 *
 * Logs RPC requests, responses, failures and duration. By default, calls whose
 * service type name contains `grpc.health` are excluded. Message bodies are
 * logged only when `includeBodies` is set.
 *
 * @module logger
 */

import type { DescMessage, Message } from "@bufbuild/protobuf";
import { toJson } from "@bufbuild/protobuf";
import type { Interceptor, StreamRequest, StreamResponse, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LoggerOptions } from "./types.ts";

/**
 * Request header and value that `@connectum/core` sets on every call made
 * through its in-process transport. Core keeps this marker out of its public
 * exports on purpose (it is not a user-facing contract), so the literals are
 * repeated here instead of imported. They must stay equal to
 * `LOCAL_TRANSPORT_HEADER` / `LOCAL_TRANSPORT_VALUE` in core's
 * `localTransport.ts`; the logger transport integration test drives real
 * in-process and HTTP calls, so any drift makes it fail.
 *
 * Core strips the header from inbound HTTP requests, so a remote caller
 * cannot make a network call look in-process to a server-side logger.
 */
const LOCAL_TRANSPORT_HEADER = "connectum-internal-transport";
const LOCAL_TRANSPORT_VALUE = "in-process";

/**
 * Transport tag for a call: `in-process` when the core in-process transport
 * marked it, `http` otherwise.
 */
function detectTransport(req: UnaryRequest | StreamRequest): "in-process" | "http" {
    return req.header.get(LOCAL_TRANSPORT_HEADER) === LOCAL_TRANSPORT_VALUE ? "in-process" : "http";
}

type LogSink = (message: string, ...args: unknown[]) => void;

/**
 * Wrap a user-supplied sink so that it can never change the outcome of a call.
 *
 * The logger observes calls; a sink that throws (a closed transport, a full
 * disk, a broken formatter) must not turn a successful response into an
 * `Internal` error or replace the real error of a failed call. A sink typed as
 * returning `void` may still be an `async` function, so a rejected promise it
 * returns counts as a failure too: left alone it would surface as an unhandled
 * rejection, which ends a Node.js process. The first failure is reported once
 * on the console so it is not silent, later ones are dropped: a sink that is
 * down fails on every line and would otherwise flood the console on every RPC.
 */
function guardSink(sink: LogSink): LogSink {
    let reported = false;
    const report = (error: unknown): void => {
        if (reported) {
            return;
        }
        reported = true;
        try {
            console.error("[@connectum/interceptors] logger sink failed; further sink failures are not reported", error);
        } catch {
            // The report is best effort: a console that throws must not change the outcome of the call either.
        }
    };
    return (message, ...args) => {
        try {
            const pending: unknown = sink(message, ...args);
            if (typeof (pending as { then?: unknown } | null | undefined)?.then === "function") {
                Promise.resolve(pending).then(undefined, report);
            }
        } catch (error) {
            report(error);
        }
    };
}

/**
 * JSON form of a message for the log, or a marker when the message cannot be
 * converted. A conversion failure is a logging problem, so it must not end the
 * stream the message belongs to.
 */
function messageToJson(schema: DescMessage, message: unknown): unknown {
    try {
        return toJson(schema, message as Message);
    } catch {
        return "[message could not be converted to JSON]";
    }
}

/** Name of the Connect code a failure maps to; plain errors map to `Unknown`. */
function failureCodeName(error: unknown): string {
    return Code[ConnectError.from(error).code];
}

/**
 * Log request stream messages
 *
 * @param stream - Input stream
 * @param msg - Log message prefix
 * @param logger - Logger function
 * @param includeBodies - Pass each message to the sink; otherwise only the event line is written
 * @returns Async generator that yields messages
 */
async function* logReqStream<T>(stream: AsyncIterable<T>, msg: string, logger: LogSink, includeBodies: boolean): AsyncGenerator<T, void, void> {
    for await (const message of stream) {
        if (includeBodies) {
            logger(`${msg} request`, message);
        } else {
            logger(`${msg} request`);
        }
        yield message;
    }
}

/**
 * Log response stream messages and close the call out when the stream ends.
 *
 * `onEnd` runs exactly once however the stream ends: fully read, failed midway,
 * or abandoned by the reader (`return()` / `break`), so the completion line and
 * the duration cover the whole stream and not just its creation.
 *
 * @param schema - Message schema
 * @param stream - Output stream
 * @param msg - Log message prefix
 * @param logger - Logger function
 * @param includeBodies - Pass each message to the sink; otherwise only the event line is written
 * @param onFailure - Called with the error that ended the stream
 * @param onEnd - Called once when the stream is over
 * @returns Async generator that yields messages
 */
async function* logResStream<T>(
    schema: DescMessage,
    stream: AsyncIterable<T>,
    msg: string,
    logger: LogSink,
    includeBodies: boolean,
    onFailure: (error: unknown) => void,
    onEnd: () => void,
): AsyncGenerator<T, void, void> {
    try {
        for await (const message of stream) {
            if (includeBodies) {
                logger(`${msg} response`, messageToJson(schema, message));
            } else {
                logger(`${msg} response`);
            }
            yield message;
        }
    } catch (error) {
        onFailure(error);
        throw error;
    } finally {
        onEnd();
    }
}

/**
 * Create logger interceptor
 *
 * Logs RPC requests and responses with timing information. By default,
 * skips calls whose service type name contains `grpc.health`; set
 * `skipHealthCheck: false` to include them.
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
 * @example Tag log lines with the transport (opt-in)
 * ```typescript
 * createLoggerInterceptor({ includeTransport: true });
 * // RPC [in-process] /greeter.v1.GreeterService/SayHello request ...   (server.localClient)
 * // RPC [http] /greeter.v1.GreeterService/SayHello request ...         (network client)
 * ```
 *
 * @example Log request and response bodies (opt-in)
 * ```typescript
 * // Bodies can carry credentials and personal data; enable only where the log is protected.
 * createLoggerInterceptor({ includeBodies: true });
 * ```
 *
 * @example Client-side usage with transport
 * ```typescript
 * import { createConnectTransport } from '@connectrpc/connect-node';
 * import { createLoggerInterceptor } from '@connectum/interceptors';
 *
 * const transport = createConnectTransport({
 *   baseUrl: 'http://localhost:5000',
 *   httpVersion: '1.1',
 *   interceptors: [
 *     createLoggerInterceptor({ level: 'debug' }),
 *   ],
 * });
 * ```
 */
export function createLoggerInterceptor(options: LoggerOptions = {}): Interceptor {
    const { level = "debug", skipHealthCheck = true, includeTransport = false, includeBodies = false } = options;
    // biome-ignore lint/suspicious/noConsole: console is the intentional default fallback logger
    const logger = guardSink(options.logger ?? console[level]);

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        // With includeTransport the tag sits between the kind and the path
        // (`RPC [http] /pkg.Service/Method ...`), so every line of one call
        // carries it and the path stays the last token before the event.
        const path = new URL(req.url).pathname;
        const label = includeTransport ? `[${detectTransport(req)}] ${path}` : path;

        // Skip health check services
        if (skipHealthCheck && req.service.typeName.includes("grpc.health")) {
            return await next(req);
        }

        const startTime = performance.now();
        const logRequest = (message: unknown): void => (includeBodies ? logger(`RPC ${label} request`, message) : logger(`RPC ${label} request`));
        const logResponse = (message: unknown): void => (includeBodies ? logger(`RPC ${label} response`, message) : logger(`RPC ${label} response`));
        const logFailure = (error: unknown): void => logger(`RPC ${label} failed with ${failureCodeName(error)}`);
        const logCompleted = (): void => logger(`RPC ${label} completed in ${(performance.now() - startTime).toFixed(2)}ms`);

        // A streamed response ends long after `next` returns, so its completion
        // line is written by the response wrapper; everything else completes here.
        let completionDeferred = false;
        try {
            // Log request (do NOT mutate req.message - it's readonly!)
            if (req.stream) {
                // Wrap stream with logging generator and create new request
                const modifiedReq = { ...req, message: logReqStream(req.message, `STREAM ${label}`, logger, includeBodies) };
                const res = await next(modifiedReq);

                if (res.stream) {
                    completionDeferred = true;
                    return {
                        ...res,
                        message: logResStream(res.method.output, res.message as AsyncIterable<Message>, `STREAM ${label}`, logger, includeBodies, logFailure, logCompleted),
                    } as StreamResponse;
                }
                return res;
            }
            // Log unary request
            logRequest(req.message);

            // Execute request
            const res = await next(req);

            // Log unary response
            logResponse(res.message);

            return res;
        } catch (error) {
            logFailure(error);
            throw error;
        } finally {
            if (!completionDeferred) {
                logCompleted();
            }
        }
    };
}
