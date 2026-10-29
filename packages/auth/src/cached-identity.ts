/**
 * Immutable copies of a verified identity for the credential cache.
 *
 * The cache hands the same stored identity to every later request with the same credential.
 * If that were the object the verifier returned, one handler (or a library it calls) that
 * pushes a role into `getAuthContext().roles` would grant that role to every later request
 * presenting the same token. The cache therefore stores a deep-frozen copy, and every request
 * receives a frozen view of it.
 *
 * @module cached-identity
 */

import type { AuthContext } from "./types.ts";

/**
 * Copy `value` and freeze the copy. Plain objects and arrays are copied recursively, so the
 * verifier's own objects are left alone (it may keep references to them). Anything else
 * (a `Date` or a class instance inside `claims`) is kept as is: it cannot be frozen
 * meaningfully, and claims from a verified token are JSON.
 */
function frozenCopy(value: unknown, copies: WeakMap<object, unknown>): unknown {
    if (typeof value !== "object" || value === null) return value;
    const known = copies.get(value);
    if (known !== undefined) return known;

    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        copies.set(value, copy);
        for (const item of value) copy.push(frozenCopy(item, copies));
        return Object.freeze(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    const copy: Record<string, unknown> = Object.create(prototype);
    copies.set(value, copy);
    for (const key of Object.keys(value)) {
        // defineProperty, not assignment: a claim named `__proto__` is data, not a prototype.
        Object.defineProperty(copy, key, {
            value: frozenCopy((value as Record<string, unknown>)[key], copies),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return Object.freeze(copy);
}

/** Deep-frozen copy of `context`, to be stored in the cache. */
export function snapshotAuthContext(context: AuthContext): AuthContext {
    const copies = new WeakMap<object, unknown>();
    // Spread first: keys the verifier added beyond the declared fields stay visible as before.
    const snapshot: AuthContext = {
        ...context,
        roles: frozenCopy(context.roles, copies) as ReadonlyArray<string>,
        scopes: frozenCopy(context.scopes, copies) as ReadonlyArray<string>,
        claims: frozenCopy(context.claims, copies) as Readonly<Record<string, unknown>>,
        ...(context.expiresAt ? { expiresAt: new Date(context.expiresAt.getTime()) } : {}),
    };
    return Object.freeze(snapshot);
}

/**
 * The identity a single request receives from a stored snapshot: a frozen shallow copy that
 * shares the frozen roles, scopes and claims and owns its `expiresAt`, because a `Date` cannot
 * be frozen and one handler must not move the expiry of the stored identity.
 */
export function viewOfSnapshot(snapshot: AuthContext): AuthContext {
    return Object.freeze({
        ...snapshot,
        ...(snapshot.expiresAt ? { expiresAt: new Date(snapshot.expiresAt.getTime()) } : {}),
    });
}
