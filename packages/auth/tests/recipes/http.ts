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
 * An engine that cannot be reached, or answers 5xx or 429, throws `ConnectError` with
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
        // A server-side failure or throttling is an outage the caller may retry. Any other refusal
        // (400, 401, 404) means the request or the connection settings are wrong: that is a defect
        // of the service, so it is thrown as a plain error, which the gate reports as Internal.
        if (reply.status >= 500 || reply.status === 429) {
            throw new ConnectError(`Authorization engine answered ${reply.status}`, Code.Unavailable);
        }
        throw new Error(`Authorization engine rejected the request with ${reply.status}`);
    }
    return await reply.json();
}
