/**
 * Validation of subscription patterns shared by every event adapter.
 *
 * @module subscriptionPatterns
 */

/**
 * Describe where the first empty segment of a pattern is, or return `undefined` when every
 * dot-separated segment has content.
 */
function emptySegmentLocation(pattern: string): string | undefined {
    if (pattern === "") {
        return "the pattern is empty";
    }

    const segments = pattern.split(".");
    const index = segments.indexOf("");
    if (index === -1) {
        return undefined;
    }
    if (index === 0) {
        return 'it starts with "."';
    }
    if (index === segments.length - 1) {
        return 'it ends with "."';
    }
    return 'it contains ".."';
}

/**
 * Reject subscription patterns that contain an empty segment.
 *
 * A pattern is a dot-separated list of segments; the empty string, `a..b`, `.a`, `a.` and `.`
 * all contain a segment with no characters. Such a pattern names no event: every broker would
 * bind it to the empty key (RabbitMQ), refuse it with a transport error that does not name the
 * pattern (NATS, Kafka), or quietly create a stream for it (Redis), so a typo in a route would
 * surface as an event that never arrives. The wildcards `*` and `>` are segments with content and
 * are not affected.
 *
 * Adapters call this at the start of `subscribe()`, before they touch the broker, so a rejected
 * call leaves no queue, consumer, stream or consumer group behind. It checks every pattern, so a
 * bad pattern next to good ones rejects the whole call.
 *
 * @param options - The adapter name used in the message and the patterns of the subscription
 * @throws {TypeError} For the first pattern with an empty segment; the message names the adapter,
 * the pattern and where the empty segment is.
 *
 * @example
 * ```typescript
 * assertSubscriptionPatterns({ adapter: "MyAdapter", patterns: ["user.created", "order.>"] }); // returns
 * assertSubscriptionPatterns({ adapter: "MyAdapter", patterns: ["user..created"] }); // throws TypeError
 * ```
 */
export function assertSubscriptionPatterns(options: { readonly adapter: string; readonly patterns: readonly string[] }): void {
    const { adapter, patterns } = options;
    for (const pattern of patterns) {
        const location = emptySegmentLocation(pattern);
        if (location !== undefined) {
            throw new TypeError(`${adapter}: subscription pattern "${pattern}" has an empty segment (${location}). Every dot-separated segment of a pattern must be non-empty.`);
        }
    }
}
