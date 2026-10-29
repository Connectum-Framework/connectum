/**
 * Type-safe function wrapper for OpenTelemetry tracing
 *
 * Wraps a single function in an OTel span without mutating prototypes.
 *
 * @module traced
 */

import { recordArgsAttribute, recordFailure } from "./failure.ts";
import { endSpanWithResult } from "./result.ts";
import { getTracer } from "./tracer.ts";
import type { TracedOptions } from "./types.ts";

/**
 * Wraps a function in an OpenTelemetry span.
 *
 * The wrapper preserves the original function's type signature.
 * Supports sync and async functions and sync and async generator functions.
 * The span ends when a returned promise settles, or when a returned generator is
 * exhausted, throws or is closed (a generator that is never iterated never ends its
 * span). A thenable that is not a native `Promise` is not awaited: the span ends when
 * the function returns.
 *
 * @param fn - The function to wrap
 * @param options - Tracing options
 * @returns Wrapped function with the same type signature
 *
 * @example
 * ```typescript
 * const findUser = traced(async (id: string) => {
 *     return await db.users.findById(id);
 * }, { name: "UserService.findUser" });
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Generic constraint requires `any` for maximum type compatibility
export function traced<T extends (...args: any[]) => any>(fn: T, options?: TracedOptions): T {
    const { name = fn.name || "anonymous", recordArgs = false, argsFilter, attributes } = options ?? {};

    const wrapper = function (this: unknown, ...args: unknown[]) {
        const tracer = getTracer();

        return tracer.startActiveSpan(name, (span) => {
            try {
                // Set custom attributes
                if (attributes) {
                    span.setAttributes(attributes);
                }

                // Record arguments if enabled
                if (recordArgs !== false) {
                    recordArgsAttribute(span, () => {
                        // A copy, as in traceAll: a filter that masks in place must not change
                        // the arguments the wrapped function receives.
                        let argsToRecord = [...args];

                        // Whitelist filtering by name/index
                        if (Array.isArray(recordArgs)) {
                            argsToRecord = args.filter((_, i) => recordArgs.includes(String(i)));
                        }

                        // Apply args filter for masking
                        if (argsFilter) {
                            argsToRecord = argsFilter(argsToRecord);
                        }

                        return argsToRecord;
                    });
                }

                // The span ends when the result is final: a promise settles, a generator is
                // exhausted or closed, anything else is final at once.
                return endSpanWithResult(span, fn.apply(this, args));
            } catch (error) {
                recordFailure(span, error);
                span.end();
                throw error;
            }
        });
    } as unknown as T;

    // Preserve function metadata
    Object.defineProperty(wrapper, "name", { value: name, configurable: true });
    Object.defineProperty(wrapper, "length", { value: fn.length, configurable: true });

    return wrapper;
}
