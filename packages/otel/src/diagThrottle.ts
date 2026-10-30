/**
 * Diagnostics logger that holds back repeated errors
 *
 * @module diagThrottle
 */

import { inspect } from "node:util";
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
 * What makes two errors "the same": the message and the text of its arguments. The SDK reports
 * different failures under one message (a metrics collection error is always the same sentence,
 * the cause is an argument), so the message alone would hide a second, unrelated failure.
 */
function identityOf(message: string, args: readonly unknown[]): string {
    const parts = args.map((arg) => {
        if (arg instanceof Error) {
            return `${arg.name}: ${arg.message}`;
        }
        if (typeof arg === "string") {
            return arg;
        }
        try {
            // Not String(): every plain object would read "[object Object]" and two different ones
            // (the instruments of two failed batch callbacks) would count as one error.
            return inspect(arg, { depth: 1, breakLength: Number.POSITIVE_INFINITY });
        } catch {
            // An argument that cannot be inspected still must not fail the report.
            return "[unprintable]";
        }
    });
    return [message, ...parts].join("\u0000");
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
    // Insertion order is print order: an entry is deleted before it is set again.
    const seen = new Map<string, Seen>();
    let lastSweep = 0;

    return {
        error(message: string, ...args: unknown[]): void {
            const time = now();
            const key = identityOf(message, args);
            const entry = seen.get(key);
            if (entry !== undefined && time - entry.printedAt < windowMs) {
                entry.heldBack += 1;
                return;
            }
            const heldBack = entry?.heldBack ?? 0;
            seen.delete(key);
            if (seen.size >= MAX_TRACKED_MESSAGES) {
                // Expired entries are dropped in one pass per window, not on every new message: with
                // messages that all differ (a request id in the body) a pass per message would be quadratic.
                if (time - lastSweep >= windowMs) {
                    lastSweep = time;
                    for (const [oldKey, value] of seen) {
                        if (time - value.printedAt >= windowMs) {
                            seen.delete(oldKey);
                        }
                    }
                }
                // Still full: every entry is inside its window, so the oldest one makes room.
                const oldest = seen.keys().next();
                if (seen.size >= MAX_TRACKED_MESSAGES && oldest.done !== true) {
                    seen.delete(oldest.value);
                }
            }
            seen.set(key, { printedAt: time, heldBack: 0 });
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
