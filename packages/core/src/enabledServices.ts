/**
 * `enabledServices` helpers — env-driven local activation of catalog services.
 *
 * `enabledServices` is a list of full proto `typeName`s that a process mounts
 * locally; everything else in the catalog is remote. Short service names are
 * NOT used — they collide (`catalog.v1.UsersService` and `auth.v1.UsersService`
 * both shorten to `users`; medium-compose finding F-E).
 *
 * @module enabledServices
 */

/**
 * Parse a comma-separated env value into a list of proto `typeName`s, trimming
 * whitespace and dropping empty entries. Returns `[]` for an empty/undefined value.
 *
 * @example `enabledServices: parseServicesEnv(process.env.CONNECTUM_SERVICES)`
 */
export function parseServicesEnv(value: string | undefined | null): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/**
 * Return the subset of `names` matching a glob `pattern`, where `*` matches any
 * run of characters (including dots). E.g. `"acme.*"` matches
 * `"acme.v1.UsersService"`. Matched without a constructed `RegExp` (segment scan).
 */
export function matchServicesPattern(pattern: string, names: readonly string[]): string[] {
    return names.filter((name) => globMatch(pattern, name));
}

/** Glob match supporting only the `*` wildcard, via segment scanning (no RegExp). */
function globMatch(pattern: string, name: string): boolean {
    const segments = pattern.split("*");
    if (segments.length === 1) return pattern === name; // no wildcard → exact match

    const first = segments[0] ?? "";
    const last = segments.at(-1) ?? "";
    if (!name.startsWith(first)) return false;
    if (!name.endsWith(last)) return false;

    // Every middle segment must appear in order, without overlapping the anchors.
    let cursor = first.length;
    const limit = name.length - last.length;
    for (let i = 1; i < segments.length - 1; i++) {
        const segment = segments[i] ?? "";
        const found = name.indexOf(segment, cursor);
        if (found === -1 || found + segment.length > limit) return false;
        cursor = found + segment.length;
    }
    return cursor <= limit;
}

/** Merge several `enabledServices` lists, de-duplicating while preserving first-seen order. */
export function mergeEnabledServices(...lists: readonly (readonly string[])[]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const list of lists) {
        for (const name of list) {
            if (!seen.has(name)) {
                seen.add(name);
                merged.push(name);
            }
        }
    }
    return merged;
}
