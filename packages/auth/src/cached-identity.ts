/**
 * Per-request copies of a verified identity for the credential cache.
 *
 * The cache hands the same stored identity to every later request with the same credential.
 * If that were the object the verifier returned, a handler (or a library it calls) that pushes
 * a role into `getAuthContext().roles` would grant that role to every later request presenting
 * the same token. The cache therefore stores a private copy, and every request, the one that
 * fills the cache included, receives its own copy of it. Handlers may change what they get,
 * exactly as they may without a cache; the change stays inside their request.
 *
 * Cost: one pass over `roles`, `scopes` and `claims` per cache hit, proportional to the size of
 * the identity, with no I/O.
 *
 * @module cached-identity
 */

import type { AuthContext } from "./types.ts";

/**
 * Copy `value` recursively. Plain objects and arrays are copied (a cycle is kept as a cycle);
 * anything else (a class instance inside `claims`) is shared, and a `Date` is copied.
 */
function deepCopy(value: unknown, copies: WeakMap<object, unknown>): unknown {
    if (typeof value !== "object" || value === null) return value;
    const known = copies.get(value);
    if (known !== undefined) return known;
    if (value instanceof Date) return new Date(value.getTime());

    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        copies.set(value, copy);
        for (const item of value) copy.push(deepCopy(item, copies));
        return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    const copy: Record<string, unknown> = Object.create(prototype);
    copies.set(value, copy);
    for (const key of Object.keys(value)) {
        // defineProperty, not assignment: a claim named `__proto__` is data, not a prototype.
        Object.defineProperty(copy, key, {
            value: deepCopy((value as Record<string, unknown>)[key], copies),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return copy;
}

/** A copy of `context` that shares no mutable state with it. Keys beyond the declared fields are kept. */
export function copyAuthContext(context: AuthContext): AuthContext {
    const copies = new WeakMap<object, unknown>();
    return {
        ...context,
        roles: deepCopy(context.roles, copies) as ReadonlyArray<string>,
        scopes: deepCopy(context.scopes, copies) as ReadonlyArray<string>,
        claims: deepCopy(context.claims, copies) as Readonly<Record<string, unknown>>,
        ...(context.expiresAt ? { expiresAt: new Date(context.expiresAt.getTime()) } : {}),
    };
}
