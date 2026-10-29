/**
 * Proxy-based object wrapper for OpenTelemetry tracing
 *
 * Wraps all methods of an object in OTel spans using ES6 Proxy.
 * Does NOT mutate the original object or its prototype.
 *
 * @module traceAll
 */

import { recordArgsAttribute, recordFailure } from "./failure.ts";
import { endSpanWithResult } from "./result.ts";
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
 * Property reads pass through untouched: getters run with the original object as
 * `this`, so getters over `#private` fields and `Map.size` work. An own method that is
 * neither writable nor configurable (a method of a frozen object) cannot be replaced by
 * a wrapper in a proxy and is returned as it is, untraced. A span ends when a returned
 * promise settles or a returned generator is exhausted, throws or is closed.
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
        get(obj, prop) {
            // The target is the receiver: a getter that reads a `#private` field or an
            // internal slot (`Map.prototype.size`, `Set.prototype.size`) throws a TypeError
            // when `this` is the proxy, so the proxy must not be what a getter sees.
            const value = Reflect.get(obj, prop, obj);

            // Only wrap functions
            if (typeof value !== "function") return value;

            // A proxy must report the real value of an own property that is neither writable
            // nor configurable (a method of a frozen object): returning a wrapper for it
            // makes every read throw a TypeError. Such a method stays untraced.
            const descriptor = Reflect.getOwnPropertyDescriptor(obj, prop);
            if (descriptor !== undefined && descriptor.configurable === false && descriptor.writable === false) return value;

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
                            recordArgsAttribute(span, () => {
                                let argsToRecord = [...args];

                                // Whitelist filtering by name/index
                                if (Array.isArray(recordArgs)) {
                                    argsToRecord = args.filter((_, i) => recordArgs.includes(String(i)));
                                }

                                // Apply method-aware args filter for masking
                                if (argsFilter) {
                                    argsToRecord = argsFilter(methodName, argsToRecord);
                                }

                                return argsToRecord;
                            });
                        }

                        // The span ends when the result is final: a promise settles, a generator is
                        // exhausted or closed, anything else is final at once.
                        return endSpanWithResult(span, value.apply(this === proxy ? obj : this, args));
                    } catch (error) {
                        recordFailure(span, error);
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
