/**
 * Scoping of the verified identity to the whole life of a call
 *
 * An authentication interceptor establishes the caller's {@link AuthContext}
 * in AsyncLocalStorage and then calls the rest of the chain. For a unary or
 * client-streaming call the handler runs inside that chain, so a plain
 * `storage.run(context, () => next(req))` is enough. For a server-streaming or
 * bidirectional call it is not: the handler is an async generator, the chain
 * returns the generator's response iterable immediately, and the transport
 * advances it later, from outside the `run` scope. Over the network that
 * advancing happens in the server's own pump; over the in-process transport it
 * happens in the caller's async context, which may even hold a different
 * verified identity. Either way the handler would lose its identity after the
 * first suspension, or see the wrong one.
 *
 * {@link runWithAuthContext} therefore also re-enters the scope for every
 * operation on the response iterator (creation, `next`, `return`, `throw`).
 * It never uses `enterWith`: the scope ends when the operation's synchronous
 * part ends, so nothing leaks into the surrounding async context, and
 * continuations created inside an operation inherit the identity from it.
 *
 * @module run-with-auth-context
 */

import type { Message } from "@bufbuild/protobuf";
import type { StreamResponse, UnaryResponse } from "@connectrpc/connect";
import { authContextStorage } from "./context.ts";
import type { AuthContext } from "./types.ts";

/**
 * Runs `invoke` with `context` as the current identity and keeps that identity
 * for every later operation on a streaming response.
 *
 * Everything else about the response is passed through untouched: descriptors,
 * headers, trailers and any other fields are carried by reference, a unary
 * response is returned as the very same object, and the arguments, results and
 * errors of every iterator operation are not altered. `return` and `throw` are
 * offered only if the underlying iterator offers them, so consumers that probe
 * for them see the same shape as before.
 *
 * @param context - Verified identity to expose through `getAuthContext()`
 * @param invoke - Calls the rest of the interceptor chain
 * @returns The chain's response, with a streaming body scoped to `context`
 *
 * @internal
 */
export async function runWithAuthContext<R extends UnaryResponse | StreamResponse>(context: AuthContext, invoke: () => Promise<R>): Promise<R> {
    const response = await authContextStorage.run(context, invoke);
    if (!response.stream) {
        return response;
    }
    const source = response.message as AsyncIterable<Message>;
    const scoped: StreamResponse = {
        ...response,
        message: {
            [Symbol.asyncIterator](): AsyncIterator<Message> {
                const iterator = authContextStorage.run(context, () => source[Symbol.asyncIterator]());
                const result: AsyncIterator<Message> = {
                    next: (...args) => authContextStorage.run(context, () => iterator.next(...args)),
                };
                if (iterator.return) {
                    const forward = iterator.return;
                    result.return = (...args) => authContextStorage.run(context, () => forward.apply(iterator, args));
                }
                if (iterator.throw) {
                    const forward = iterator.throw;
                    result.throw = (...args) => authContextStorage.run(context, () => forward.apply(iterator, args));
                }
                return result;
            },
        },
    };
    return scoped as R;
}
