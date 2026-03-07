/**
 * Wildcard pattern matching for event topics.
 *
 * Supports two wildcard tokens:
 * - `*` matches exactly one segment (dot-separated)
 * - `>` matches one or more trailing segments
 *
 * @module wildcard
 */

/**
 * Match a topic against a wildcard pattern.
 *
 * @param pattern - Pattern with optional `*` and `>` wildcards
 * @param topic - Concrete topic name to match
 * @returns true if the topic matches the pattern
 *
 * @example
 * ```typescript
 * matchPattern("user.*", "user.created")         // true
 * matchPattern("user.*", "user.created.v2")      // false
 * matchPattern("user.>", "user.created")         // true
 * matchPattern("user.>", "user.created.v2")      // true
 * matchPattern("user.created", "user.created")   // true
 * ```
 */
export function matchPattern(pattern: string, topic: string): boolean {
    const patternParts = pattern.split(".");
    const topicParts = topic.split(".");

    for (let i = 0; i < patternParts.length; i++) {
        const p = patternParts[i];

        // ">" matches one or more remaining segments
        if (p === ">") {
            return i === patternParts.length - 1 && i < topicParts.length;
        }

        // No more topic segments to match
        if (i >= topicParts.length) {
            return false;
        }

        // "*" matches exactly one segment
        if (p === "*") {
            continue;
        }

        // Literal match
        if (p !== topicParts[i]) {
            return false;
        }
    }

    // All pattern parts consumed -- topic must also be fully consumed
    return patternParts.length === topicParts.length;
}
