/**
 * Structural check of the value a verifier callback returns.
 *
 * `verifyCredentials` and `mapSession` are typed to return an `AuthContext`, but a callback
 * written in plain JavaScript, or a typed one that returns `db.find(key)`, can hand back
 * `null`, `false` or `{}`. Without a check such a value is treated as a verified identity:
 * the handler runs without one, or the header write throws and the caller sees `internal`.
 *
 * @module auth-context-check
 */

import type { AuthContext } from "./types.ts";

/**
 * Most items a `roles` or `scopes` list may hold. It equals the length limit of the roles and
 * scopes headers: a list longer than that cannot be written into them (every item takes at least
 * three characters), and the bound keeps a hostile or broken list, such as an array of length
 * 1e9 or a proxy that reports a huge length, from being walked item by item.
 */
export const MAX_LIST_ITEMS = 8192;

/**
 * An array of at most {@link MAX_LIST_ITEMS} items that are all strings (the shape of `roles` and
 * `scopes`). The items are read by index, so a hole is read as `undefined` and fails: `every`,
 * `map` and `filter` skip holes, which would let a sparse list through and change it later.
 * An array subclass or a proxy of an array is accepted when its items are strings; properties
 * other than the items are not looked at. The length is checked before any item is read, and a
 * getter or proxy trap that throws makes the value no list.
 */
export function isStringList(value: unknown): value is string[] {
    try {
        if (!Array.isArray(value)) return false;
        const length = value.length;
        if (length > MAX_LIST_ITEMS) return false;
        for (let index = 0; index < length; index++) {
            if (typeof value[index] !== "string") return false;
        }
        return true;
    } catch {
        // An item getter or a proxy trap that throws makes the value no list.
        return false;
    }
}

/**
 * Whether `value` has the shape of an {@link AuthContext}: string `subject` and `type`,
 * string-list `roles` and `scopes`, an object `claims`, an optional string `name` and an
 * optional `Date` `expiresAt`. Only the shape is checked; the values are the verifier's.
 * An object whose property read throws (a getter, a proxy trap) is not an identity: the
 * answer is `false`, not an exception.
 */
export function isAuthContext(value: unknown): value is AuthContext {
    if (typeof value !== "object" || value === null) return false;
    try {
        const candidate = value as Record<string, unknown>;
        return (
            typeof candidate.subject === "string" &&
            typeof candidate.type === "string" &&
            isStringList(candidate.roles) &&
            isStringList(candidate.scopes) &&
            typeof candidate.claims === "object" &&
            candidate.claims !== null &&
            !Array.isArray(candidate.claims) &&
            (candidate.name === undefined || typeof candidate.name === "string") &&
            (candidate.expiresAt === undefined || candidate.expiresAt instanceof Date)
        );
    } catch {
        return false;
    }
}
