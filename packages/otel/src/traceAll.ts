/**
 * Proxy-based object wrapper for OpenTelemetry tracing
 *
 * Wraps all methods of an object in OTel spans using ES6 Proxy.
 * Does NOT mutate the original object or its prototype.
 *
 * @module traceAll
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./tracer.ts";
import type { TraceAllOptions } from "./types.ts";

/** WeakSet to prevent double-wrapping */
const wrapped = new WeakSet<object>();

/**
 * Wraps all methods of an object in OpenTelemetry spans using ES6 Proxy.
 *
 * Creates a Proxy that intercepts method calls and wraps each in a span.
 * Method wrappers are created lazily (on first access, not at Proxy creation).
 * Does NOT mutate the original object or its prototype.
 *
 * @param target - The object whose methods to trace
 * @param options - Tracing options
 * @returns A Proxy with traced methods
 *
 * @example
 * ```typescript
 * const service = traceAll(new UserService(), {
 *     prefix: "UserService",
 *     exclude: ["internalHelper"],
 * });
 * ```
 */
export function traceAll<T extends object>(target: T, options?: TraceAllOptions): T {
    // Prevent double-wrapping
    if (wrapped.has(target)) return target;

    const { prefix = (target.constructor?.name !== "Object" ? target.constructor?.name : undefined) ?? "Object", include, exclude, recordArgs = false, argsFilter } = options ?? {};

    const includeSet = include ? new Set(include) : undefined;
    const excludeSet = exclude ? new Set(exclude) : undefined;

    const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
            const value = Reflect.get(obj, prop, receiver);

            // Only wrap functions
            if (typeof value !== "function") return value;

            // Skip constructor
            if (prop === "constructor") return value;

            // Only string keys (skip symbols)
            if (typeof prop !== "string") return value;

            // Apply include/exclude filters
            if (excludeSet?.has(prop)) return value;
            if (includeSet && !includeSet.has(prop)) return value;

            // Return traced wrapper (created lazily)
            const spanName = `${prefix}.${prop}`;
            const methodName = prop;

            return function (this: unknown, ...args: unknown[]) {
                const tracer = getTracer();

                return tracer.startActiveSpan(spanName, (span) => {
                    try {
                        // Record args if enabled
                        if (recordArgs !== false) {
                            let argsToRecord = [...args];

                            // Whitelist filtering by name/index
                            if (Array.isArray(recordArgs)) {
                                argsToRecord = args.filter((_, i) => recordArgs.includes(String(i)));
                            }

                            // Apply method-aware args filter for masking
                            if (argsFilter) {
                                argsToRecord = argsFilter(methodName, argsToRecord);
                            }

                            span.setAttribute("function.args", JSON.stringify(argsToRecord));
                        }

                        const result = value.apply(this === proxy ? obj : this, args);

                        // Handle async results
                        if (result instanceof Promise) {
                            return result.then(
                                (val) => {
                                    span.setStatus({ code: SpanStatusCode.OK });
                                    span.end();
                                    return val;
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
            };
        },
    });

    wrapped.add(proxy);

    return proxy;
}
