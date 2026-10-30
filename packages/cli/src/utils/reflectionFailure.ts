/**
 * Wording of a failed reflection request for the user.
 *
 * The reflection client reports transport failures with Connect's own messages, which are empty
 * or opaque for the failures that matter most to someone running `proto sync`: a closed port is
 * `[unavailable]` with no text, an HTTP/1.1 server is `[internal] Protocol error`, and none of
 * them says which server was asked. This module adds the address and the likely reason. It lives
 * apart from the client so that the client's programmatic errors stay what they were.
 *
 * @module utils/reflectionFailure
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { CliError } from "./cliError.ts";

/**
 * The first string `code` in the cause chain of `error`, looking into the members of an
 * `AggregateError` too. A Connect error carries a numeric `code` of its own, which is skipped:
 * what is wanted is the operating-system or Node.js code underneath (`ECONNREFUSED`,
 * `ERR_HTTP2_ERROR`).
 */
function underlyingCode(error: unknown): string | undefined {
    const seen = new Set<object>();
    const queue: unknown[] = [error];
    while (queue.length > 0) {
        const item = queue.shift();
        if (typeof item !== "object" || item === null || seen.has(item)) {
            continue;
        }
        seen.add(item);
        const { code, cause, errors } = item as { code?: unknown; cause?: unknown; errors?: unknown };
        if (typeof code === "string") {
            return code;
        }
        queue.push(cause, ...(Array.isArray(errors) ? errors : []));
    }
    return undefined;
}

/**
 * Turns a failed reflection request into an error the user can act on.
 *
 * A {@link CliError} is returned as it is (it is already worded). A Connect error is rewritten to
 * name the address and, where the cause is recognised, the reason: nobody listening, or a server
 * that does not speak HTTP/2. Anything else is returned unchanged, because it is a defect and not
 * a failed request.
 *
 * @param url - The address the request was sent to
 * @param error - What the reflection client threw
 */
export function describeReflectionFailure(url: string, error: unknown): unknown {
    if (!(error instanceof ConnectError)) {
        return error;
    }
    const underlying = underlyingCode(error);
    // Node raises ERR_HTTP2_ERROR when the peer answers an HTTP/2 connection preface with something
    // else, which is what an HTTP/1.1-only server does. Connect reports it as `[internal] Protocol error`.
    if (underlying === "ERR_HTTP2_ERROR") {
        return new CliError(
            `HTTP/2 protocol error talking to ${url} (${error.rawMessage}). The address probably serves HTTP/1.1 only, which this command cannot use: it speaks gRPC over HTTP/2. A Connectum server on plain TCP serves HTTP/1.1 only unless it is created with allowHTTP1: false.`,
            { cause: error },
        );
    }
    if (error.code === Code.Unavailable) {
        return new CliError(`Cannot connect to ${url}: ${underlying ?? "the server is unavailable"}. Check the address and that the server is running.`, { cause: error });
    }
    return new CliError(`Reflection request to ${url} failed: ${error.message}`, { cause: error });
}
