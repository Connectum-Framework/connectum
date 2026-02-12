/**
 * Type-safe function wrapper for OpenTelemetry tracing
 *
 * Wraps a single function in an OTel span without mutating prototypes.
 *
 * @module traced
 */

import { SpanStatusCode } from "@opentelemetry/api";
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
                    let argsToRecord = args;

                    // Whitelist filtering by name/index
                    if (Array.isArray(recordArgs)) {
                        argsToRecord = args.filter((_, i) => recordArgs.includes(String(i)));
                    }

                    // Apply args filter for masking
                    if (argsFilter) {
                        argsToRecord = argsFilter(argsToRecord);
                    }

                    span.setAttribute("function.args", JSON.stringify(argsToRecord));
                }

                const result = fn.apply(this, args);

                // Handle async results
                if (result instanceof Promise) {
                    return result.then(
                        (value) => {
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.end();
                            return value;
                        },
                        (error) => {
                            span.recordException(error as Error);
                            span.setStatus({
                                code: SpanStatusCode.ERROR,
                                message: (error as Error).message,
                            });
                            span.end();
                            throw error;
                        },
                    );
                }

                // Sync result
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return result;
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
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
