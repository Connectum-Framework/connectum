/**
 * Which consumer of a subscription handles a message that several of its patterns match.
 *
 * Every pattern of a subscription keeps its own durable consumer, and a JetStream consumer delivers
 * a stream message once, so a message matched by three patterns reaches the adapter three times.
 * Exactly one of those deliveries must run the handler. The deliveries are told apart by the
 * pattern of the consumer that made them: the handler runs for the delivery of the most specific
 * pattern among those whose consumer delivers (or already delivered) that message; the other
 * deliveries are acknowledged and skipped.
 *
 * A consumer delivers every matching message from its start sequence on. The start sequence of a
 * consumer that existed before the subscription is recorded in the consumer's own metadata the first
 * time this adapter version attaches to it, so every replica of the group skips the same deliveries.
 * Replicas that disagree on a start sequence can only run the handler twice for a message, never
 * zero times: a delivery is skipped only when a more specific consumer is known to deliver it too.
 *
 * @module patternOwner
 */

const SEPARATOR = ".";
const SINGLE = "*";
const TAIL = ">";

/** Whether the subject tokens are matched by the pattern tokens under NATS rules (`*` one token, trailing `>` one or more). */
function matchesTokens(pattern: readonly string[], subject: readonly string[]): boolean {
    for (const [i, token] of pattern.entries()) {
        if (token === TAIL) {
            return i === pattern.length - 1 && subject.length > i;
        }
        if (i >= subject.length) {
            return false;
        }
        if (token !== SINGLE && token !== subject[i]) {
            return false;
        }
    }
    return pattern.length === subject.length;
}

/** Whether `subject` is matched by `pattern` under NATS rules (`*` one token, trailing `>` one or more). */
export function matchesPattern(pattern: string, subject: string): boolean {
    return matchesTokens(pattern.split(SEPARATOR), subject.split(SEPARATOR));
}

/**
 * Order patterns from the most to the least specific. The order is total and derived from the
 * pattern text alone, so every replica of a group arrives at the same owner for a message.
 * Fewer `>` first, then fewer `*`, then more tokens, then the text itself.
 */
export function comparePatterns(a: string, b: string): number {
    const ta = a.split(SEPARATOR);
    const tb = b.split(SEPARATOR);
    const tails = Number(ta.includes(TAIL)) - Number(tb.includes(TAIL));
    if (tails !== 0) return tails;
    const singles = ta.filter((t) => t === SINGLE).length - tb.filter((t) => t === SINGLE).length;
    if (singles !== 0) return singles;
    const length = tb.length - ta.length;
    if (length !== 0) return length;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** A pattern of the subscription together with the first stream sequence its consumer delivers. */
export interface OwnedPattern {
    readonly pattern: string;
    /** The pattern split into tokens once, so matching a message does not split it again. */
    readonly tokens: readonly string[];
    /** Messages with a stream sequence at or above this one are delivered by the pattern's consumer. */
    readonly startSeq: number;
}

/** Pair a pattern with the first stream sequence its consumer delivers. */
export function ownedPattern(pattern: string, startSeq: number): OwnedPattern {
    return { pattern, tokens: pattern.split(SEPARATOR), startSeq };
}

/**
 * The pattern whose consumer's delivery runs the handler for `subject` at stream sequence `seq`:
 * the most specific of the patterns that match it and whose consumer delivers that sequence.
 * `patterns` must be sorted with {@link comparePatterns}. Returns `undefined` when none matches,
 * which cannot happen for a delivery of one of the patterns' own consumers.
 */
export function ownerOf(patterns: readonly OwnedPattern[], subject: string, seq: number): string | undefined {
    const subjectTokens = subject.split(SEPARATOR);
    for (const { pattern, tokens, startSeq } of patterns) {
        if (seq >= startSeq && matchesTokens(tokens, subjectTokens)) {
            return pattern;
        }
    }
    return undefined;
}
