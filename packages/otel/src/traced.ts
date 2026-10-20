/**
 * Type-safe function wrapper for OpenTelemetry tracing
 *
 * Wraps a single function in an OTel span without mutating prototypes.
 *
 * @module traced
 */

import { recordArgsAttribute, recordFailure } from "./shared.ts";
import { getTracer } from "./tracer.ts";
import type { TracedOptions } from "./types.ts";

/**
 * Wraps a function in an OpenTelemetry span.
 *
 * The wrapper preserves the original function's type signature.
 * Supports both sync and async functions.
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
                        let argsToRecord = args;

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

                const result = fn.apply(this, args);

                // Handle async results
                if (result instanceof Promise) {
                    return result.then(
                        (value) => {
                            // Success leaves the status unset; only a failure sets ERROR.
                            span.end();
                            return value;
                        },
                        (error) => {
                            recordFailure(span, error);
                            span.end();
                            throw error;
                        },
                    );
                }

                // Sync result: success leaves the status unset.
                span.end();
                return result;
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
