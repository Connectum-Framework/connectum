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
    /** Adds an event to the span while it is open. */
    event(name: string): void;
    /** Ends the span once, marking it failed when given a failure; later calls do nothing. */
    finish(failure?: { error: unknown }): void;
    /**
     * Ends the span of a call whose result nobody finished, at the moment the traced function
     * returned and with an event that says so; does nothing once the span has ended. It holds
     * the span and nothing else, in particular not the context of the call: the garbage
     * collector's registry keeps it, and a context can reach the very object it waits for.
     */
    abandon: () => void;
}

/** The span a live trace still has to end; emptied at the end, so a kept trace does not hold a finished span. */
interface OpenSpan {
    span: Span | undefined;
}

/** Lives apart from {@link createLiveTrace} so that its closure holds only what it names. */
function abandonSpan(open: OpenSpan, returnedAt: number): () => void {
    return () => {
        const span = open.span;
        if (span === undefined) return;
        open.span = undefined;
        span.addEvent("connectum.result.unread", returnedAt);
        span.end(returnedAt);
    };
}

function createLiveTrace(span: Span, scope: Context): LiveTrace {
    // Each span keeps its own moment: layers that follow one thenable return at different times.
    // A number is the SDK's own form of a monotonic time: it converts it to the clock of the span.
    const returnedAt = performance.now();
    const open: OpenSpan = { span };
    let current: { span: Span; scope: Context } | undefined = { span, scope };
    return {
        scope: () => current?.scope,
        event: (name) => current?.span.addEvent(name),
        finish(failure) {
            const live = current;
            current = undefined;
            open.span = undefined;
            if (live === undefined) return;
            if (failure) recordFailure(live.span, failure.error);
            live.span.end();
        },
        abandon: abandonSpan(open, returnedAt),
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
 * What every traced layer that follows one thenable shares. It is reachable from the
 * thenable only (through the `then` put on it).
 */
interface Followed {
    /** The spans that end when the thenable settles, the oldest first. */
    lives: LiveTrace[];
    /**
     * What the registry below holds for this thenable: the abandon function of each span. It
     * must not reach the thenable, which is why it is a list of its own and not `lives`:
     * a live trace holds the context of the call, and a context can hold the thenable.
     */
    abandoners: Array<() => void>;
    /** Whether the thenable has been read: the first `then` call marks the end of the idle time. */
    read: boolean;
}

/** The state of a thenable that is being followed, by the replaced `then` method it carries. */
const followed = new WeakMap<object, Followed>();

/** How many traced layers may follow one thenable; the spans past the limit end at once. */
const MAX_FOLLOWERS = 8;

/**
 * A thenable that is collected without being read (a builder consumed through `exec()`,
 * `stream()` or `toSQL()`, or dropped) never calls its `then`. Its spans end then, at the
 * moment their function returned and with an event that says so, which is what they looked like before
 * thenables were followed: an exported span that records that the call happened. The
 * collector decides when this runs, so the span appears late and not at all when the
 * process ends first.
 */
const unread = new FinalizationRegistry<Array<() => void>>((abandoners) => {
    for (const abandon of abandoners.splice(0)) abandon();
});

/**
 * The `then` of a thenable that is not a native promise, read without trusting the
 * object: a getter that throws must not break the call, and a `then` that is not a
 * function does not make an object a thenable.
 */
function thenOf(result: unknown): ((...args: unknown[]) => unknown) | undefined {
    if ((typeof result !== "object" && typeof result !== "function") || result === null) return undefined;
    try {
        // A `then` that is a getter is left alone, unread: it can have effects of its own, and it
        // is read again on every use, which a fixed function in its place would change. The method
        // is taken from the property itself and not by a read: a read through a proxy hands out the
        // proxy's own wrapper, which would then run a second time under the one we put on.
        for (let holder: object | null = result; holder !== null; holder = Object.getPrototypeOf(holder)) {
            const found = Object.getOwnPropertyDescriptor(holder, "then");
            if (found === undefined) continue;
            if (found.get !== undefined || found.set !== undefined) return undefined;
            return typeof found.value === "function" ? (found.value as (...args: unknown[]) => unknown) : undefined;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * The state of the traced layers already following a thenable, found through the `then`
 * the thenable owns. A proxy hands out a new function on every read, so the `then` that
 * was read says nothing about it; the own property, which a proxy forwards to its target,
 * does.
 */
function followedBy(thenable: object): Followed | undefined {
    try {
        const own = Object.getOwnPropertyDescriptor(thenable, "then")?.value;
        return typeof own === "function" ? followed.get(own) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Replaces `then` of a thenable with a version that ends the span when the thenable
 * settles. The method is put on the thenable itself, not on a promise made from it: the
 * caller keeps the very object the function returned, so a query builder keeps its
 * chain methods and its prototype, and a lazy thenable is not started before the caller
 * reads it (turning it into a promise would run it at once). The original `then` runs
 * inside the span's context, so the work a lazy thenable starts there is a child of the
 * span. Callbacks are wrapped, not replaced: the caller's handlers get the same value or
 * error, and run in the context of the call to `then`.
 *
 * A rejection handler of ours goes to the original `then` only when the caller passed one.
 * Without it, the original gets nothing in that place, as it would without tracing: a
 * thenable that checks for a handler stays silent as before, and one that returns a
 * native promise has the failure of that promise observed (and passed on unchanged).
 *
 * When the thenable settles the span ends and the object is put back as it was: the own
 * `then` it had, or none when `then` came from its prototype.
 *
 * @returns `false` when the object does not accept the method (it is frozen or sealed)
 */
function traceThenable(thenable: object, original: (...args: unknown[]) => unknown, live: LiveTrace): boolean {
    try {
        const ownDescriptor = Object.getOwnPropertyDescriptor(thenable, "then");
        const state: Followed = { lives: [live], abandoners: [live.abandon], read: false };

        // The method put on the thenable; `settle` runs only after it has been defined.
        let installed: unknown;
        const settle = (failure?: { error: unknown }) => {
            const lives = state.lives.splice(0);
            if (lives.length === 0) return;
            for (const l of lives) l.finish(failure);
            unread.unregister(state.abandoners);
            state.abandoners.length = 0;
            try {
                // A thenable that replaced its own `then` while it ran (a memoized result, say) keeps what it set.
                if (Object.getOwnPropertyDescriptor(thenable, "then")?.value !== installed) return;
                // biome-ignore lint/suspicious/noThenProperty: giving the object back the `then` it had
                if (ownDescriptor) Object.defineProperty(thenable, "then", ownDescriptor);
                else delete (thenable as { then?: unknown }).then;
            } catch {
                // Intentionally empty: an object that stopped accepting changes keeps the wrapper, which only forwards.
            }
        };

        const traced = function then(this: unknown, onFulfilled?: unknown, onRejected?: unknown, ...rest: unknown[]): unknown {
            const scope = state.lives[0]?.scope();
            // Arguments after the two handlers (a progress callback, say) reach the original.
            if (scope === undefined) return original.call(this, onFulfilled, onRejected, ...rest);
            if (!state.read) {
                // The time between the call that returned the thenable and this one is idle time.
                state.read = true;
                for (const l of state.lives) l.event("connectum.result.read");
            }
            // The caller's handlers run in the context of the call to `then`, as a native
            // promise runs them, not in the span's context: the span is over by then.
            const caller = context.active();
            const handler = (callback: unknown, receiver: unknown, args: unknown[]) => context.with(caller, () => (callback as (...a: unknown[]) => unknown).apply(receiver, args));
            // The first handler a thenable calls decides the outcome, as for a promise: a later
            // call (a rejection after a resolution) reaches the caller's handler but not the span.
            let decided = false;
            try {
                const returned = context.with(scope, () =>
                    original.call(
                        this,
                        // A handler of ours reaches the original only in the place where the caller
                        // put one. A missing handler stays missing, as without tracing, so a thenable
                        // that looks for one stays silent as before. Receiver and every argument
                        // pass through: a thenable may call its handler with more than the value.
                        typeof onFulfilled === "function"
                            ? function (this: unknown, ...args: unknown[]) {
                                  if (decided) return handler(onFulfilled, this, args);
                                  decided = true;
                                  const value = args[0];
                                  // A native promise passed on as the value is awaited by the caller as
                                  // well, so the work lasts until that promise settles, and its failure
                                  // is the failure of the call. (A nested thenable is not read here:
                                  // reading it would run a lazy one twice. Observing the promise counts
                                  // as handling it; a thenable that hands a promise to a callback that
                                  // ignores it is not one that follows the promise rules.)
                                  if (types.isPromise(value))
                                      value.then(
                                          () => settle(),
                                          (error: unknown) => settle({ error }),
                                      );
                                  else settle();
                                  return handler(onFulfilled, this, args);
                              }
                            : onFulfilled,
                        typeof onRejected === "function"
                            ? function (this: unknown, ...args: unknown[]) {
                                  if (!decided) {
                                      decided = true;
                                      settle({ error: args[0] });
                                  }
                                  return handler(onRejected, this, args);
                              }
                            : onRejected,
                        ...rest,
                    ),
                );
                // Where no handler of ours reached the original, the outcome shows only in the
                // promise it returned (every real library returns a native one). The span follows
                // it and the caller gets the same outcome.
                if ((typeof onFulfilled !== "function" || typeof onRejected !== "function") && types.isPromise(returned)) {
                    return returned.then(
                        (value: unknown) => {
                            settle();
                            return value;
                        },
                        (error: unknown) => {
                            settle({ error });
                            throw error;
                        },
                    );
                }
                return returned;
            } catch (error) {
                // A throw after a handler was called is ignored by the promise rules: it does not change the outcome.
                if (!decided) settle({ error });
                throw error;
            }
        };

        // biome-ignore lint/suspicious/noThenProperty: making the result observable by `await` is the purpose of this method
        Object.defineProperty(thenable, "then", {
            value: traced,
            writable: true,
            configurable: true,
            // Keep the shape of the object: an own enumerable `then` stays enumerable, a
            // `then` of the prototype is shadowed by a non-enumerable one.
            enumerable: ownDescriptor?.enumerable ?? false,
        });
        installed = traced;
        followed.set(traced, state);
        // The held value reaches the spans but neither the thenable nor the contexts of the calls.
        unread.register(thenable, state.abandoners, state.abandoners);
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
 *   followed at once, not when somebody reads it. The caller receives a new promise, not
 *   the one the function returned.
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
 *   same object: `then` is replaced on the object itself until it settles, then put
 *   back, so its prototype, its chain methods and its laziness stay, and the work a lazy
 *   thenable starts in `then` runs with the span as the active span. The span also covers
 *   the time between the call and the first read, and an event `connectum.result.read`
 *   marks where that idle time ends. Traced layers that return the same thenable one from
 *   another (`traceAll` over a repository inside `traceAll` over a service) all end with
 *   it, up to eight; the spans past that limit end at once. A thenable that accepts no
 *   own `then` (it is frozen) is returned as it is and its span ends at once.
 * - Anything else, including other iterables (arrays, `Map`, streams): the call is over,
 *   the span ends now.
 *
 * A generator that is never iterated never ends its span. A thenable that is never read
 * through `then` (a builder consumed through `exec()`, `stream()`, `cursor()`, `clone()`
 * or `toSQL()`, an immutable builder whose chain methods return new objects) ends its span
 * when the garbage collector collects it, at the moment its function returned and with an event
 * `connectum.result.unread`; the moment is up to the collector, and a process that ends
 * first exports nothing.
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
    if (then !== undefined) {
        const open = followedBy(result as object);
        if (open === undefined) {
            if (traceThenable(result as object, then, createLiveTrace(span, context.active()))) return result;
        } else if (open.lives.length > 0 && open.lives.length < MAX_FOLLOWERS) {
            // Another traced layer already follows this thenable and it has not settled: this
            // span rides along and ends with the same outcome, so every layer covers the work.
            const live = createLiveTrace(span, context.active());
            if (open.read) live.event("connectum.result.read");
            open.lives.push(live);
            open.abandoners.push(live.abandon);
            return result;
        }
    }

    // Sync result, or a thenable that accepts no own `then`, or one followed by too many layers.
    span.end();
    return result;
}
