/**
 * Reduction of subscription patterns to a set of consumer filters that never overlap.
 *
 * A JetStream consumer delivers a stream message once per consumer. When one
 * subscription creates a consumer for every pattern, an event whose subject
 * matches several of them is delivered, and handled, once per matching consumer.
 * Servers also differ in which overlapping filters one consumer may carry (2.10
 * rejects any overlap), so a single multi-filter consumer is not an option.
 * Instead the patterns are reduced to a cover: a set of patterns, no two of which
 * can match the same subject, that together match every subject the original
 * patterns match.
 *
 * @module patternCover
 */

/** NATS subject tokens are separated by dots; `*` matches one token, a trailing `>` one or more. */
const SEPARATOR = ".";
const SINGLE = "*";
const TAIL = ">";

function tokens(pattern: string): string[] {
    return pattern.split(SEPARATOR);
}

/**
 * Whether every subject matched by `narrow` is also matched by `wide`.
 */
function subsumes(wide: string, narrow: string): boolean {
    const w = tokens(wide);
    const n = tokens(narrow);
    for (const [i, token] of w.entries()) {
        if (token === TAIL) {
            // `>` needs at least one token at its position, and swallows whatever follows.
            return n.length > i;
        }
        const other = n[i];
        if (other === undefined || other === TAIL) {
            // `narrow` is shorter, or reaches beyond `wide` with its own `>`.
            return false;
        }
        if (token !== SINGLE && token !== other) {
            return false;
        }
    }
    return n.length === w.length;
}

/**
 * Whether at least one subject is matched by both patterns.
 */
function collides(a: string, b: string): boolean {
    const x = tokens(a);
    const y = tokens(b);
    for (let i = 0; ; i++) {
        const left = x[i];
        const right = y[i];
        if (left === TAIL) {
            return right !== undefined;
        }
        if (right === TAIL) {
            return left !== undefined;
        }
        if (left === undefined || right === undefined) {
            return left === right;
        }
        if (left !== SINGLE && right !== SINGLE && left !== right) {
            return false;
        }
    }
}

/**
 * The narrowest single pattern matching everything both patterns match: their
 * common literal prefix followed by `>`, or `>` alone when there is none.
 */
function widen(a: string, b: string): string {
    const x = tokens(a);
    const y = tokens(b);
    const prefix: string[] = [];
    for (const [i, token] of x.entries()) {
        if (token === SINGLE || token === TAIL || token !== y[i]) {
            break;
        }
        prefix.push(token);
    }
    return [...prefix, TAIL].join(SEPARATOR);
}

/** Consumer filters for one subscription. */
export interface PatternCover {
    /** Patterns to create consumers for; no two can match the same subject. */
    readonly filters: readonly string[];
    /**
     * `true` when the filters match exactly what the original patterns match. `false` when two patterns
     * that partly overlap had to be replaced by a wider one: the consumer then also receives subjects
     * that none of the original patterns match, and the adapter must drop them.
     */
    readonly exact: boolean;
}

/**
 * Reduce `patterns` to a cover without overlaps.
 *
 * Duplicates and patterns contained in another one are dropped, which keeps the result exact.
 * Patterns that overlap only in part (`a.*.c` and `a.b.*` both match `a.b.c`) are replaced by the
 * narrowest single pattern covering both, and the result is flagged as not exact.
 * Patterns that do not overlap with any other are returned unchanged, in their original order.
 */
export function coverPatterns(patterns: readonly string[]): PatternCover {
    let current = [...new Set(patterns)];
    let exact = true;

    for (;;) {
        current = current.filter((candidate, i) => !current.some((other, j) => i !== j && subsumes(other, candidate)));

        let pair: [number, number] | undefined;
        for (let i = 0; i < current.length && pair === undefined; i++) {
            for (let j = i + 1; j < current.length; j++) {
                if (collides(current[i] as string, current[j] as string)) {
                    pair = [i, j];
                    break;
                }
            }
        }
        if (pair === undefined) {
            return { filters: current, exact };
        }

        const [i, j] = pair;
        const merged = widen(current[i] as string, current[j] as string);
        current = [...current.filter((_, k) => k !== i && k !== j), merged];
        exact = false;
    }
}

/**
 * Whether `subject` is matched by at least one of `patterns`.
 */
export function matchesAny(patterns: readonly string[], subject: string): boolean {
    return patterns.some((pattern) => collides(pattern, subject));
}
