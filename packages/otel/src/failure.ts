/**
 * Recording of failures and call arguments that cannot disturb the observed call
 *
 * Internal module (not a package entry point): telemetry code sits on the path of the
 * user's call, so nothing here may throw into it or replace what the call returned
 * or threw.
 *
 * @module failure
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";

/**
 * Text of a thrown value that is not an error object.
 *
 * Never throws: a value whose string conversion fails (a hostile `toString`) must not
 * replace the value the caller is about to receive. The empty string is quoted so the
 * recorded message is not blank.
 */
function describeThrown(value: unknown): string {
    if (value === "") return '""';
    try {
        return String(value);
    } catch {
        return "unprintable thrown value";
    }
}

/**
 * Marks a span as failed by whatever value was thrown.
 *
 * Any thrown value is a failure, including `null`, `undefined`, `0` and `""`:
 * reading `.message` off such a value would throw a `TypeError` of our own and replace
 * the value the caller must receive. An error object (or an object with a text
 * `message`) is recorded as is; anything else is recorded as its text. It never throws,
 * whatever the thrown value looks like.
 *
 * @param span - The span to mark
 * @param error - The thrown value, exactly as caught
 */
export function recordFailure(span: Span, error: unknown): void {
    try {
        if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: (error as { message: string }).message });
            return;
        }
        const text = describeThrown(error);
        span.recordException(text);
        span.setStatus({ code: SpanStatusCode.ERROR, message: text });
    } catch {
        // A thrown object can have hostile accessors (a `message` getter that throws, a revoked
        // proxy), and the SDK reads several of its properties. Whatever fails here must not
        // replace the value the caller is about to receive, so one more attempt marks the span
        // with a fixed text and a second failure is ignored.
        try {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "unreadable thrown value" });
        } catch {
            // Intentionally empty: the span stays as it is, the call is unaffected.
        }
    }
}

/**
 * Records `function.args` on a span without ever disturbing the call being observed.
 *
 * Collecting the arguments (the user's filter) and serializing them can fail: a
 * `BigInt` or a circular structure makes `JSON.stringify` throw, a filter may have a
 * bug. The call is more important than its attribute, so on any failure the
 * attribute is left unset. Nothing is recorded that the filter did not approve.
 *
 * @param span - The span to put the attribute on
 * @param collect - Produces the arguments to record (whitelist and filter applied)
 */
export function recordArgsAttribute(span: Span, collect: () => unknown[]): void {
    try {
        span.setAttribute("function.args", JSON.stringify(collect()));
    } catch {
        // Intentionally empty: see above, the attribute is simply not recorded.
    }
}
