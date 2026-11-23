/**
 * Shared transport of the engine recipes: a JSON POST through an injected `fetch`, so a test can
 * assert the exact request and no recipe depends on a client library.
 */

import { Code, ConnectError } from "@connectrpc/connect";

/** The part of `fetch` the recipes use. The global `fetch` satisfies it. */
export type FetchLike = (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * POST a JSON body and return the parsed JSON reply.
 *
 * An engine that cannot be reached, or answers with an error status, throws `ConnectError` with
 * `Code.Unavailable`, which the resource gate passes to the client unchanged. The engine's own
 * error text is kept out of the message.
 */
export async function postJson(fetchLike: FetchLike, url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    let reply: Awaited<ReturnType<FetchLike>>;
    try {
        reply = await fetchLike(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (cause) {
        throw new ConnectError("Authorization engine is unreachable", Code.Unavailable, undefined, undefined, cause);
    }
    if (!reply.ok) {
        throw new ConnectError(`Authorization engine answered ${reply.status}`, Code.Unavailable);
    }
    return await reply.json();
}
