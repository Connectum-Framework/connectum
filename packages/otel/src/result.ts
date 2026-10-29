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
 * Ends the span of a traced function at the right moment and returns what the caller
 * must receive in place of `result`.
 *
 * - A native `Promise`: the span ends when it settles; a rejection marks it failed.
 * - A sync or async generator object (the result of calling a `function*` or
 *   `async function*`): the function body has not run yet, so the span stays open until
 *   the generator is exhausted, throws, or is closed early. Each step runs with the span
 *   as the active span, so spans that the generator body starts are its children. The
 *   caller receives the same generator object: its `next`, `return` and `throw` are
 *   replaced on the object itself, so its prototype and any property the function
 *   added to it stay. A generator that accepts no own properties (it is frozen) is
 *   returned as it is and its span ends at once.
 * - Anything else, including other iterables (arrays, `Map`, streams) and thenables
 *   that are not native promises: the call is over, the span ends now.
 *
 * A generator that is never iterated never ends its span: no code of it runs.
 *
 * @param span - The span of the call, active in the current context
 * @param result - What the traced function returned
 * @returns The value the traced wrapper returns
 */
export function endSpanWithResult(span: Span, result: unknown): unknown {
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

    const tag = generatorTagOf(result);
    if (tag === "Generator") return traceGenerator(result as Generator, createLiveTrace(span, context.active()));
    if (tag === "AsyncGenerator") return traceAsyncGenerator(result as AsyncGenerator, createLiveTrace(span, context.active()));

    // Sync result: success leaves the status unset.
    span.end();
    return result;
}
