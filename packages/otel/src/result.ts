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

/** Ends a span once; later calls (a second `return()` after exhaustion) are no-ops. */
function onceEnder(span: Span): (failure?: { error: unknown }) => void {
    let ended = false;
    return (failure) => {
        if (ended) return;
        ended = true;
        if (failure) recordFailure(span, failure.error);
        span.end();
    };
}

/**
 * A sync generator whose steps run in the span's context and whose span ends when the
 * generator is exhausted, throws, or is closed with `return()` / `throw()`.
 */
function traceGenerator(generator: Generator, scope: Context, end: ReturnType<typeof onceEnder>): Generator {
    const step = (run: () => IteratorResult<unknown, unknown>): IteratorResult<unknown, unknown> => {
        let result: IteratorResult<unknown, unknown>;
        try {
            result = context.with(scope, run);
        } catch (error) {
            end({ error });
            throw error;
        }
        if (result.done) end();
        return result;
    };
    const traced = {
        next: (...args: [] | [unknown]) => step(() => generator.next(...args)),
        return: (value?: unknown) => step(() => generator.return(value)),
        throw: (error?: unknown) => step(() => generator.throw(error)),
        [Symbol.iterator]() {
            return traced;
        },
    };
    return traced as unknown as Generator;
}

/** The async counterpart of {@link traceGenerator}. */
function traceAsyncGenerator(generator: AsyncGenerator, scope: Context, end: ReturnType<typeof onceEnder>): AsyncGenerator {
    const step = async (run: () => Promise<IteratorResult<unknown, unknown>>): Promise<IteratorResult<unknown, unknown>> => {
        let result: IteratorResult<unknown, unknown>;
        try {
            result = await context.with(scope, run);
        } catch (error) {
            end({ error });
            throw error;
        }
        if (result.done) end();
        return result;
    };
    const traced = {
        next: (...args: [] | [unknown]) => step(() => generator.next(...args)),
        return: (value?: unknown) => step(() => generator.return(value)),
        throw: (error?: unknown) => step(() => generator.throw(error)),
        [Symbol.asyncIterator]() {
            return traced;
        },
    };
    return traced as unknown as AsyncGenerator;
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
 *   caller receives an iterator with the same protocol.
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
    if (tag === "Generator") return traceGenerator(result as Generator, context.active(), onceEnder(span));
    if (tag === "AsyncGenerator") return traceAsyncGenerator(result as AsyncGenerator, context.active(), onceEnder(span));

    // Sync result: success leaves the status unset.
    span.end();
    return result;
}
