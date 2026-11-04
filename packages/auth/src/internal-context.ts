/**
 * Record of the identities that the internal interceptor established
 *
 * An `internal` proto method is open to a trusted internal caller only. Whether a caller
 * is trusted is decided by `createInternalAuthInterceptor`; the proto authorization
 * interceptor, further down the chain, must be able to tell an identity produced there from
 * any other identity (an end-user JWT, a gateway header). It cannot tell from the shape of
 * the identity: every authentication interceptor returns the same `AuthContext`.
 *
 * The record is a `WeakSet` of the `AuthContext` objects themselves, so nothing a caller
 * sends (a token claim, a header) can put an identity into it: only code in this process
 * that holds the object can. It lives on `globalThis` under a `Symbol.for` key, like the
 * context storage, so two copies of this module in one process (source and built output)
 * share one record instead of each trusting nothing the other marked.
 *
 * @module internal-context
 */

import type { AuthContext } from "./types.ts";

const REGISTRY_KEY = Symbol.for("@connectum/auth/internal-contexts");

function registry(): WeakSet<object> {
    const holder = globalThis as Record<symbol, unknown>;
    const existing = holder[REGISTRY_KEY];
    if (existing instanceof WeakSet) {
        return existing;
    }
    const created = new WeakSet<object>();
    holder[REGISTRY_KEY] = created;
    return created;
}

/** Record `context` as an identity the internal interceptor established. */
export function markInternalContext(context: AuthContext): void {
    registry().add(context);
}

/** Whether `context` is an identity the internal interceptor established. */
export function isInternalContext(context: AuthContext): boolean {
    return registry().has(context);
}
