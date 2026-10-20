/**
 * Validation of subscription patterns for event adapters whose broker cannot serve some of them.
 *
 * @module subscriptionPatterns
 */

/**
 * What a rule refuses:
 *
 * - `"no-empty-segment"` -- any pattern with an empty dot-separated segment (the empty string,
 *   `a..b`, `.a`, `a.`, `.`). For brokers whose subject syntax has no empty token (NATS) and for
 *   the in-memory adapter, which matches the same way.
 * - `"kafka-topic-name"` -- only the names Kafka reserves: the empty string, `.` and `..`. Every
 *   other name with an empty segment (`a..b`, `.a`, `a.`) is a legal Kafka topic.
 */
export type SubscriptionPatternRule = "no-empty-segment" | "kafka-topic-name";

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
 * Reject subscription patterns that the adapter's broker cannot serve.
 *
 * Adapters call this at the start of `subscribe()`, before they touch the broker, so a rejected
 * call leaves no consumer or consumer group behind. It checks every pattern, so a bad pattern next
 * to good ones rejects the whole call. The wildcards `*` and `>` are segments with content and are
 * never refused by either rule. Adapters whose broker accepts any key (Redis, RabbitMQ) do not
 * call it.
 *
 * @param options.adapter - The adapter name used in the message
 * @param options.patterns - The patterns of the subscription
 * @param options.rule - What to refuse; `"no-empty-segment"` when omitted
 * @throws {TypeError} For the first refused pattern; the message names the adapter and the pattern.
 *
 * @example
 * ```typescript
 * assertSubscriptionPatterns({ adapter: "MyAdapter", patterns: ["user.created", "order.>"] }); // returns
 * assertSubscriptionPatterns({ adapter: "MyAdapter", patterns: ["user..created"] }); // throws TypeError
 * assertSubscriptionPatterns({ adapter: "MyAdapter", patterns: ["user..created"], rule: "kafka-topic-name" }); // returns
 * ```
 */
export function assertSubscriptionPatterns(options: { readonly adapter: string; readonly patterns: readonly string[]; readonly rule?: SubscriptionPatternRule }): void {
    const { adapter, patterns, rule = "no-empty-segment" } = options;
    for (const pattern of patterns) {
        if (rule === "kafka-topic-name") {
            if (pattern === "" || pattern === "." || pattern === "..") {
                throw new TypeError(`${adapter}: subscription pattern "${pattern}" is not a valid Kafka topic name. Kafka reserves the names "", "." and "..".`);
            }
            continue;
        }
        const location = emptySegmentLocation(pattern);
        if (location !== undefined) {
            throw new TypeError(`${adapter}: subscription pattern "${pattern}" has an empty segment (${location}). Every dot-separated segment of a pattern must be non-empty.`);
        }
    }
}
