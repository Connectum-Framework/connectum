/**
 * Diagnostics logger that holds back repeated errors
 *
 * @module diagThrottle
 */

import type { DiagLogger } from "@opentelemetry/api";

/** Entries kept before expired ones are dropped; bounds memory when every message differs. */
const MAX_TRACKED_MESSAGES = 100;

/** Options of {@link createThrottledDiagLogger}. */
export interface ThrottledDiagLoggerOptions {
    /** Logger that receives the messages that are printed. */
    readonly target: DiagLogger;
    /** How long an identical error message is held back after it was printed, in milliseconds. */
    readonly windowMs: number;
    /** Clock, replaceable in tests. */
    readonly now?: () => number;
}

interface Seen {
    printedAt: number;
    heldBack: number;
}

/**
 * Wraps a diagnostics logger so that an `error` message already printed within `windowMs` is
 * not printed again. When the window has passed, the message is printed again with the number
 * of copies that were held back.
 *
 * An OTLP exporter reports each failed export as an error; with an unreachable collector
 * that is one report per span batch, per exported log record and per metric interval. Other
 * levels are forwarded untouched.
 */
export function createThrottledDiagLogger(options: ThrottledDiagLoggerOptions): DiagLogger {
    const { target, windowMs } = options;
    const now = options.now ?? Date.now;
    const seen = new Map<string, Seen>();

    return {
        error(message: string, ...args: unknown[]): void {
            const time = now();
            const entry = seen.get(message);
            if (entry !== undefined && time - entry.printedAt < windowMs) {
                entry.heldBack += 1;
                return;
            }
            if (seen.size >= MAX_TRACKED_MESSAGES) {
                for (const [key, value] of seen) {
                    if (time - value.printedAt >= windowMs) {
                        seen.delete(key);
                    }
                }
            }
            const heldBack = entry?.heldBack ?? 0;
            seen.set(message, { printedAt: time, heldBack: 0 });
            if (heldBack > 0) {
                target.error(`${message} (repeated ${heldBack} more time${heldBack === 1 ? "" : "s"} in the last ${windowMs / 1000} s)`, ...args);
            } else {
                target.error(message, ...args);
            }
        },
        warn: (message, ...args) => target.warn(message, ...args),
        info: (message, ...args) => target.info(message, ...args),
        debug: (message, ...args) => target.debug(message, ...args),
        verbose: (message, ...args) => target.verbose(message, ...args),
    };
}
