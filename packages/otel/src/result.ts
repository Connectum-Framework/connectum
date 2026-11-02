/**
 * Ending the span of a traced function when its result is known
 *
 * Internal module (not a package entry point), shared by `traced()` and `traceAll()`.
 * A function result is not always final when the function returns: a promise is
 * pending and a generator has not run yet. The span must cover the work that the
 * caller still awaits or iterates, not only the call itself.
 *
 * @module result
 */

import { types } from "node:util";

import type { Context, Span } from "@opentelemetry/api";
import { context } from "@opentelemetry/api";

import { recordFailure } from "./failure.ts";

/**
 * Tag of a generator object, read without trusting the object: a getter that throws
 * must not break the call, and only a real iterator (it has `next`) is wrapped.
 */
function generatorTagOf(result: unknown): "Generator" | "AsyncGenerator" | undefined {
    if (typeof result !== "object" || result === null) return undefined;
    try {
        if (typeof (result as { next?: unknown }).next !== "function") return undefined;
        const tag = Object.prototype.toString.call(result);
        if (tag === "[object Generator]") return "Generator";
        if (tag === "[object AsyncGenerator]") return "AsyncGenerator";
    } catch {
        // Intentionally empty: an object that cannot be inspected is returned as it is.
    }
    return undefined;
}

/**
 * The span and the context a traced generator runs in, until it ends.
 *
 * Ending clears both: the methods put on a generator that the caller keeps (a cursor in
 * a field, say) would otherwise hold the finished span, with its attributes and events,
 * and the context of the call for as long as the generator lives. After the end they run
 * the original method and nothing else.
 */
interface LiveTrace {
    /** The context to run a step in, or `undefined` once the generator has ended. */
    scope(): Context | undefined;
    /** Ends the span once, marking it failed when given a failure; later calls do nothing. */
    finish(failure?: { error: unknown }): void;
}

function createLiveTrace(span: Span, scope: Context): LiveTrace {
    let current: { span: Span; scope: Context } | undefined = { span, scope };
    return {
        scope: () => current?.scope,
        finish(failure) {
            const live = current;
            current = undefined;
            if (live === undefined) return;
            if (failure) recordFailure(live.span, failure.error);
            live.span.end();
        },
    };
}

/**
 * Replaces the three protocol methods of a generator object with versions that run through
 * `step`. The methods are put on the generator itself, not on a new object: the caller
 * keeps the very object the function returned, with its prototype (so it is still an
 * `Iterator`, still its own iterable, and keeps the iterator helpers and the disposal
 * methods, which call `next` and `return` on it) and with any property the function
 * added to it. They are non-enumerable, so the shape of the object does not change.
 * Installation is all or nothing: when one method cannot be replaced the ones already
 * replaced are put back.
 *
 * @returns `false` when the object does not accept the methods (it is frozen or sealed)
 */
function interceptSteps(generator: object, step: (run: () => unknown) => unknown): boolean {
    const target = generator as Record<"next" | "return" | "throw", (...args: unknown[]) => unknown>;
    const replaced: Array<readonly [string, PropertyDescriptor | undefined]> = [];
    try {
        for (const method of ["next", "return", "throw"] as const) {
            const original = target[method];
            // `return` and `throw` are optional in the iterator protocol; a method the object
            // does not have stays absent, so a consumer that probes for it sees the same shape.
            if (typeof original !== "function") continue;
            replaced.push([method, Object.getOwnPropertyDescriptor(generator, method)]);
            Object.defineProperty(generator, method, {
                value: (...args: unknown[]) => step(() => original.apply(generator, args)),
                writable: true,
                configurable: true,
                enumerable: false,
            });
        }
        return true;
    } catch {
        for (const [method, descriptor] of replaced) {
            try {
                if (descriptor) Object.defineProperty(generator, method, descriptor);
                else delete (generator as Record<string, unknown>)[method];
            } catch {
                // Intentionally empty: the method that cannot be put back is not a method that was replaced.
            }
        }
        return false;
    }
}

/**
 * Makes the steps of a sync generator run in the span's context and ends the span when the
 * generator is exhausted, throws, or is closed with `return()` / `throw()`.
 */
function traceGenerator(generator: Generator, live: LiveTrace): Generator {
    const step = (run: () => unknown): unknown => {
        const scope = live.scope();
        if (scope === undefined) return run();
        let result: IteratorResult<unknown, unknown>;
        try {
            result = context.with(scope, run) as IteratorResult<unknown, unknown>;
        } catch (error) {
            live.finish({ error });
            throw error;
        }
        if (result.done) live.finish();
        return result;
    };
    if (!interceptSteps(generator, step)) live.finish();
    return generator;
}

/** The async counterpart of {@link traceGenerator}. */
function traceAsyncGenerator(generator: AsyncGenerator, live: LiveTrace): AsyncGenerator {
    const step = async (run: () => unknown): Promise<unknown> => {
        const scope = live.scope();
        if (scope === undefined) return run();
        let result: IteratorResult<unknown, unknown>;
        try {
            result = (await context.with(scope, run)) as IteratorResult<unknown, unknown>;
        } catch (error) {
            live.finish({ error });
            throw error;
        }
        if (result.done) live.finish();
        return result;
    };
    if (!interceptSteps(generator, step)) live.finish();
    return generator;
}

/**
 * The `then` of a thenable that is not a native promise, read without trusting the
 * object: a getter that throws must not break the call, and a `then` that is not a
 * function does not make an object a thenable.
 */
function thenOf(result: unknown): ((...args: unknown[]) => unknown) | undefined {
    if ((typeof result !== "object" && typeof result !== "function") || result === null) return undefined;
    try {
        const then = (result as { then?: unknown }).then;
        return typeof then === "function" ? (then as (...args: unknown[]) => unknown) : undefined;
    } catch {
        return undefined;
    }
}

/** The `then` methods this module has put on thenables, to tell an object that is already followed. */
const tracedThens = new WeakSet<object>();

/**
 * Replaces `then` of a thenable with a version that ends the span when the thenable
 * settles. The method is put on the thenable itself, not on a promise made from it: the
 * caller keeps the very object the function returned, so a query builder keeps its
 * chain methods and its prototype, and a lazy thenable is not started before the caller
 * reads it (turning it into a promise would run it at once). The original `then` runs
 * inside the span's context, so the work a lazy thenable starts there is a child of the
 * span. Callbacks are wrapped, not replaced: the caller's handlers get the same value or
 * error, and a missing handler passes the outcome on, as the Promises/A+ rules for `then`
 * require (a thenable that expects `then` without a rejection handler to stay silent
 * about a failure is not a promise in that sense).
 * Every call to `then` is served by the original method; the span ends once.
 *
 * @returns `false` when the object does not accept the method (it is frozen or sealed)
 */
function traceThenable(thenable: object, original: (...args: unknown[]) => unknown, live: LiveTrace): boolean {
    try {
        const traced = function then(this: unknown, onFulfilled?: unknown, onRejected?: unknown, ...rest: unknown[]): unknown {
            const scope = live.scope();
            // Arguments after the two handlers (a progress callback, say) reach the original.
            if (scope === undefined) return original.call(this, onFulfilled, onRejected, ...rest);
            // The caller's handlers run in the context of the call to `then`, as a native
            // promise runs them, not in the span's context: the span is over by then.
            const caller = context.active();
            const handler = (callback: unknown, receiver: unknown, args: unknown[]) => context.with(caller, () => (callback as (...a: unknown[]) => unknown).apply(receiver, args));
            try {
                return context.with(scope, () =>
                    original.call(
                        this,
                        // Receiver and every argument pass through: a thenable may call
                        // its handler with more than the value.
                        function (this: unknown, ...args: unknown[]) {
                            const value = args[0];
                            // A native promise passed on as the value is awaited by the caller as
                            // well, so the work lasts until that promise settles, and its failure is
                            // the failure of the call. (A nested thenable is not read here: reading
                            // it would run a lazy one twice.)
                            if (types.isPromise(value))
                                value.then(
                                    () => live.finish(),
                                    (error: unknown) => live.finish({ error }),
                                );
                            else live.finish();
                            return typeof onFulfilled === "function" ? handler(onFulfilled, this, args) : args[0];
                        },
                        function (this: unknown, ...args: unknown[]) {
                            live.finish({ error: args[0] });
                            if (typeof onRejected === "function") return handler(onRejected, this, args);
                            throw args[0];
                        },
                        ...rest,
                    ),
                );
            } catch (error) {
                live.finish({ error });
                throw error;
            }
        };
        tracedThens.add(traced);
        // biome-ignore lint/suspicious/noThenProperty: making the result observable by `await` is the purpose of this method
        Object.defineProperty(thenable, "then", {
            value: traced,
            writable: true,
            configurable: true,
            // Keep the shape of the object: an own enumerable `then` stays enumerable, a
            // `then` of the prototype is shadowed by a non-enumerable one.
            enumerable: Object.getOwnPropertyDescriptor(thenable, "then")?.enumerable ?? false,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ends the span of a traced function at the right moment and returns what the caller
 * must receive in place of `result`.
 *
 * - A native `Promise`, of this realm or of another (a `vm` context): the span ends when
 *   it settles; a rejection marks it failed. A promise is already running, so it is
 *   followed at once, not when somebody reads it.
 * - A sync or async generator object (the result of calling a `function*` or
 *   `async function*`): the function body has not run yet, so the span stays open until
 *   the generator is exhausted, throws, or is closed early. Each step runs with the span
 *   as the active span, so spans that the generator body starts are its children. The
 *   caller receives the same generator object: its `next`, `return` and `throw` are
 *   replaced on the object itself, so its prototype and any property the function
 *   added to it stay. A generator that accepts no own properties (it is frozen) is
 *   returned as it is and its span ends at once.
 * - A thenable that is not a native promise (a query builder such as Knex or a Mongoose
 *   `Query`, any object with a `then` method): the span ends when the thenable settles,
 *   which is when the caller reads it with `await` or `then()`. The caller receives the
 *   same object: `then` is replaced on the object itself, so its prototype, its chain
 *   methods and its laziness stay, and the work a lazy thenable starts in `then` runs
 *   with the span as the active span. A thenable that accepts no own `then` (it is
 *   frozen), and one that an earlier call already follows (the function returns the same
 *   cached object each time), is returned as it is and its span ends at once.
 * - Anything else, including other iterables (arrays, `Map`, streams): the call is over,
 *   the span ends now.
 *
 * A generator that is never iterated, and a thenable that is never read, never end their
 * span: nothing of them has run, or nobody learns that it finished. Such a span is not
 * exported. To trace a thenable that is consumed some other way (a builder's `exec()`),
 * wrap the call in an async function.
 *
 * @param span - The span of the call, active in the current context
 * @param result - What the traced function returned
 * @returns The value the traced wrapper returns
 */
export function endSpanWithResult(span: Span, result: unknown): unknown {
    // `instanceof` misses a native promise made in another realm, and such a promise can
    // be awaited by code of its own realm without ever calling a replaced `then`.
    if (result instanceof Promise || types.isPromise(result)) {
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

    const tag = generatorTagOf(result);
    if (tag === "Generator") return traceGenerator(result as Generator, createLiveTrace(span, context.active()));
    if (tag === "AsyncGenerator") return traceAsyncGenerator(result as AsyncGenerator, createLiveTrace(span, context.active()));

    const then = thenOf(result);
    // A thenable that an earlier call already follows (a cached query, a shared object) is not
    // wrapped again: every call would add a layer that stays for the life of the object, and the
    // outcome would belong to more than one span. Its span ends now, like that of a plain result.
    if (then !== undefined && !tracedThens.has(then) && traceThenable(result as object, then, createLiveTrace(span, context.active()))) return result;

    // Sync result, or a thenable that accepts no own `then`: success leaves the status unset.
    span.end();
    return result;
}
