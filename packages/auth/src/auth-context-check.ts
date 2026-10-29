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

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Whether `value` has the shape of an {@link AuthContext}: string `subject` and `type`,
 * string-array `roles` and `scopes`, an object `claims`, an optional string `name` and an
 * optional `Date` `expiresAt`. Only the shape is checked; the values are the verifier's.
 */
export function isAuthContext(value: unknown): value is AuthContext {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.subject === "string" &&
        typeof candidate.type === "string" &&
        isStringArray(candidate.roles) &&
        isStringArray(candidate.scopes) &&
        typeof candidate.claims === "object" &&
        candidate.claims !== null &&
        !Array.isArray(candidate.claims) &&
        (candidate.name === undefined || typeof candidate.name === "string") &&
        (candidate.expiresAt === undefined || candidate.expiresAt instanceof Date)
    );
}
