/**
 * Error handler interceptor
 *
 * Transforms errors into ConnectError with proper error codes.
 * Recognizes SanitizableError protocol for safe client-facing messages.
 *
 * @module errorHandler
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { isSanitizableError } from "@connectum/core";
import type { ErrorHandlerOptions } from "./types.ts";

/**
 * Text a client receives for a failure that is not a ConnectError or SanitizableError.
 *
 * An internal failure gets the same fixed text Connect-ES uses when no interceptor
 * is installed; a failure that carried its own numeric code gets no text at all,
 * because the code alone tells the client what happened.
 */
function clientMessageFor(code: Code): string {
    return code === Code.Internal ? "internal error" : "";
}

/**
 * Whether a thrown value's `code` can be sent to the client as a Connect code.
 *
 * Only the integers from `Canceled` (1) to `Unauthenticated` (16) are failure codes.
 * Anything else (`0` is "OK" in gRPC, `17`, a fraction, `NaN`, an HTTP status, a system
 * errno) is rewritten or rejected by the wire layer, so the client would see an
 * unrelated code, a protocol error or an `invalid grpc-status` text instead of a failure.
 */
function isConnectCode(value: unknown): value is Code {
    return typeof value === "number" && Number.isInteger(value) && value >= Code.Canceled && value <= Code.Unauthenticated;
}

/**
 * Create error handler interceptor
 *
 * Catches rejections from awaiting next(req) and transforms them into
 * ConnectError instances with proper error codes. Recognizes SanitizableError for safe
 * client-facing messages while preserving server details for logging.
 *
 * What a client receives for each kind of thrown value:
 * - `ConnectError`: passes through unchanged, text and details included. Its author
 *   chose to send them.
 * - `SanitizableError`: its `clientMessage` and code only; `serverDetails` stay on the server.
 * - Anything else (`Error`, a thrown string, an object with a numeric `code`): the code is
 *   the numeric `code` when it is an integer from 1 to 16 (a Connect failure code) and
 *   `Internal` otherwise (no code, a non-number, or a number outside 1..16). The text of the failure
 *   is NOT sent: `Internal` carries the fixed text `"internal error"`, any other code carries
 *   an empty text. A message such as a connection string or a query would otherwise leak
 *   to every caller (CWE-209). Set `exposeErrorMessages: true` to send the original text.
 *
 * The original failure always stays on the server: as `cause` of the thrown ConnectError
 * (no transport serializes `cause`), in `onError` as `info.error` with its original text,
 * and in the console log.
 *
 * Place this interceptor first to normalize rejections from downstream interceptors.
 * It does not wrap response-stream iteration after next(req) returns, or errors
 * from request gates that run before the interceptor chain.
 *
 * @param options - Error handler options
 * @returns ConnectRPC interceptor
 *
 * @example Server-side usage with createServer
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { createErrorHandlerInterceptor } from '@connectum/interceptors';
 * import { myRoutes } from './routes.js';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   interceptors: [
 *     createErrorHandlerInterceptor({
 *       onError: ({ error, code, serverDetails, stack }) => {
 *         logger.error('RPC error', { error: error.message, code, serverDetails, stack });
 *       },
 *     }),
 *   ],
 * });
 *
 * await server.start();
 * ```
 */
export function createErrorHandlerInterceptor(options: ErrorHandlerOptions = {}): Interceptor {
    const { logErrors = process.env.NODE_ENV !== "production", includeStackTrace = process.env.NODE_ENV !== "production", onError, exposeErrorMessages = false } = options;

    return (next) => async (req) => {
        try {
            return await next(req);
        } catch (err) {
            // SanitizableError: preserve server details for logging, sanitize for client
            if (isSanitizableError(err)) {
                if (onError) {
                    const info: Parameters<NonNullable<ErrorHandlerOptions["onError"]>>[0] = {
                        error: err as Error,
                        code: err.code,
                        serverDetails: err.serverDetails,
                    };
                    const errStack = (err as Error).stack;
                    if (includeStackTrace && errStack) info.stack = errStack;
                    onError(info);
                } else if (logErrors) {
                    console.error("Interceptor caught error:", err);
                    console.error("Transformed ConnectError:", err.clientMessage);
                    if (includeStackTrace && (err as Error).stack) {
                        console.error("Stack trace:", (err as Error).stack);
                    }
                }
                throw new ConnectError(err.clientMessage, err.code);
            }

            // Non-sanitizable errors
            const errWithCode = err as { code?: unknown };
            const code = isConnectCode(errWithCode?.code) ? errWithCode.code : Code.Internal;
            // `full` keeps the original text and cause: it is for the server side only.
            // `client` is what leaves the process. A ConnectError is sent as its author built
            // it (text, details and metadata included). For any other failure, unless the
            // operator opted in, `client` carries no text of the original and holds the
            // original only as `cause`, which no transport serializes.
            const full = ConnectError.from(err, code);
            const client = exposeErrorMessages || err instanceof ConnectError ? full : new ConnectError(clientMessageFor(full.code), full.code, undefined, undefined, err);

            if (onError) {
                // The code the client receives: `ConnectError.from` may map the error to a different
                // code than the one picked above (an `AbortError` becomes `Canceled`).
                const info: Parameters<NonNullable<ErrorHandlerOptions["onError"]>>[0] = {
                    error: full,
                    code: full.code,
                };
                if (includeStackTrace && full.stack) info.stack = full.stack;
                onError(info);
            } else if (logErrors) {
                console.error("Interceptor caught error:", err);
                console.error("Transformed ConnectError:", client);
                if (includeStackTrace && full.stack) {
                    console.error("Stack trace:", full.stack);
                }
            }

            throw client;
        }
    };
}
