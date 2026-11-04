/**
 * What a traced function returns decides when its span ends.
 *
 * A generator function returns before any of its body has run, so a span that ends
 * when the function returns has zero duration and covers nothing. These tests pin that
 * the span of a `traced()` function and of a `traceAll()` method stays open while the
 * caller iterates the generator, that the generator body runs with the span active,
 * that failures and early exits end it correctly, and that results which are not
 * generators or thenables (arrays, maps) are returned untouched. A thenable that is not
 * a native promise keeps its span open until it settles and is returned as the same object.
 */

process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay, setImmediate as nextImmediate } from "node:timers/promises";
import { types } from "node:util";
import { setFlagsFromString } from "node:v8";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { context, createContextKey, DiagLogLevel, diag, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-node";
import { shutdownProvider } from "../../src/provider.ts";
import { traceAll } from "../../src/traceAll.ts";
import { traced } from "../../src/traced.ts";
import { observe, onlySpan } from "./observe.ts";

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

/** The span a body sees as active, so a test can ask it whether it is still recording. */
function activeSpan(): Span {
    const span = trace.getActiveSpan();
    assert.ok(span, "the generator body must run with the span of the traced function active");
    return span;
}

/** Starts and ends a child span, returning the id of the span that was active when it started. */
function childParentId(): string | undefined {
    let parent: string | undefined;
    trace.getTracer("traced-results-test").startActiveSpan("child", (child) => {
        parent = (child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
        child.end();
    });
    return parent;
}

describe("span lifetime of a traced generator", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    for (const [label, makeTraced] of [
        ["traced()", <T extends (...args: never[]) => unknown>(fn: T) => traced(fn as never, { name: "work" }) as T],
        ["traceAll()", <T extends (...args: never[]) => unknown>(fn: T) => (traceAll({ work: fn }, { prefix: "Obj" }) as { work: T }).work],
    ] as const) {
        describe(label, () => {
            it("keeps the span of an async generator open until the generator is exhausted", async () => {
                const seen: Span[] = [];
                const work = makeTraced(async function* () {
                    seen.push(activeSpan());
                    await delay(20);
                    seen.push(activeSpan());
                    yield 1;
                    await delay(20);
                    seen.push(activeSpan());
                    yield 2;
                });

                const values: number[] = [];
                const recordingAtYield: boolean[] = [];
                const observed = await observe(async () => {
                    for await (const value of work()) {
                        values.push(value);
                        recordingAtYield.push(seen[0]?.isRecording() ?? false);
                    }
                });

                assert.deepStrictEqual(values, [1, 2]);
                assert.deepStrictEqual(recordingAtYield, [true, true], "the span is still open while the caller iterates");
                assert.strictEqual(seen.length, 3);
                assert.ok(seen.every((span) => span === seen[0]), "every step runs under the same span");
                assert.strictEqual(seen[0]?.isRecording(), false, "the span ends after the last message");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps the span of a sync generator open until the generator is exhausted", async () => {
                const seen: Span[] = [];
                const work = makeTraced(function* () {
                    seen.push(activeSpan());
                    yield 1;
                    seen.push(activeSpan());
                    yield 2;
                });

                const recordingAtYield: boolean[] = [];
                const observed = await observe(async () => {
                    for (const _ of work()) recordingAtYield.push(seen[0]?.isRecording() ?? false);
                });

                assert.deepStrictEqual(recordingAtYield, [true, true]);
                assert.strictEqual(seen[0]?.isRecording(), false);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("parents the spans that the generator body starts to the traced span", async () => {
                const work = makeTraced(async function* () {
                    await delay(5);
                    yield childParentId();
                });

                let parent: string | undefined;
                const observed = await observe(async () => {
                    for await (const value of work()) parent = value;
                });

                const spans = observed.spans;
                assert.strictEqual(spans.length, 2);
                const outer = spans.find((s) => s.name !== "child");
                assert.ok(outer);
                assert.strictEqual(parent, outer.spanId);
            });

            it("ends the span with ERROR and the message when the body throws, and rethrows to the caller", async () => {
                const work = makeTraced(async function* () {
                    yield 1;
                    await delay(5);
                    throw new Error("generator boom");
                });

                const observed = await observe(async () => {
                    await assert.rejects(
                        (async () => {
                            for await (const _ of work()) {
                                // Drain until the body throws.
                            }
                        })(),
                        { message: "generator boom" },
                    );
                });

                const span = onlySpan(observed);
                assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
                assert.strictEqual(span.status.message, "generator boom");
            });

            it("ends a sync generator span with ERROR when the body throws", async () => {
                const work = makeTraced(function* () {
                    yield 1;
                    throw new Error("sync generator boom");
                });

                const observed = await observe(async () => {
                    assert.throws(() => {
                        for (const _ of work()) {
                            // Drain until the body throws.
                        }
                    }, { message: "sync generator boom" });
                });

                const span = onlySpan(observed);
                assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
                assert.strictEqual(span.status.message, "sync generator boom");
            });

            it("ends the span, leaves the status unset and runs the body's finally block when the consumer stops early", async () => {
                let cleanedUp = false;
                let seen: Span | undefined;
                const work = makeTraced(async function* () {
                    seen = activeSpan();
                    try {
                        yield 1;
                        yield 2;
                    } finally {
                        cleanedUp = true;
                    }
                });

                const observed = await observe(async () => {
                    for await (const _ of work()) break;
                });

                assert.strictEqual(cleanedUp, true);
                assert.strictEqual(seen?.isRecording(), false);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("ends the span when the generator is closed before the first step", async () => {
                let started = false;
                const work = makeTraced(async function* () {
                    started = true;
                    yield 1;
                });

                const observed = await observe(async () => {
                    const generator = work() as AsyncGenerator;
                    await generator.return(undefined);
                });

                assert.strictEqual(started, false, "the body never ran");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("passes a value into the generator, and returns the return value, like the original generator", async () => {
                const work = makeTraced(function* (): Generator<string, string, string> {
                    const answer = yield "question";
                    return `got ${answer}`;
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<string, string, string>;
                    assert.deepStrictEqual(generator.next(), { value: "question", done: false });
                    assert.deepStrictEqual(generator.next("42"), { value: "got 42", done: true });
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("lets the caller throw into the generator and handle the error inside it", async () => {
                const work = makeTraced(function* () {
                    try {
                        yield 1;
                    } catch (error) {
                        yield `caught ${(error as Error).message}`;
                    }
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<string | number>;
                    generator.next();
                    assert.deepStrictEqual(generator.throw(new Error("injected")), { value: "caught injected", done: false });
                    assert.deepStrictEqual(generator.next(), { value: undefined, done: true });
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("returns an iterator that is its own iterable, so for-of and spread work", async () => {
                const work = makeTraced(function* () {
                    yield 1;
                    yield 2;
                });

                await observe(async () => {
                    const generator = work() as Generator<number>;
                    assert.strictEqual(generator[Symbol.iterator](), generator);
                    assert.deepStrictEqual([...generator], [1, 2]);
                });
            });

            // The platform puts the iterator helpers on the prototype all iterators share; an
            // iterator built from a plain object would lose them.
            it("returns a sync iterator that keeps the iterator helpers of the platform", async () => {
                const work = makeTraced(function* () {
                    yield 1;
                    yield 2;
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<number>;
                    assert.ok(generator instanceof Iterator, "the result is an Iterator");
                    assert.deepStrictEqual(generator.map((value) => value * 10).toArray(), [10, 20]);
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("closes the generator and ends the span through Symbol.dispose, where the platform defines it", { skip: typeof (Iterator.prototype as { [Symbol.dispose]?: unknown })[Symbol.dispose] !== "function" }, async () => {
                let cleanedUp = false;
                const work = makeTraced(function* () {
                    try {
                        yield 1;
                    } finally {
                        cleanedUp = true;
                    }
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<number> & Disposable;
                    generator.next();
                    generator[Symbol.dispose]();
                });

                assert.strictEqual(cleanedUp, true);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("returns an async iterator that is its own async iterable and closes through Symbol.asyncDispose, where the platform defines it", async () => {
                let cleanedUp = false;
                const work = makeTraced(async function* () {
                    try {
                        yield 1;
                    } finally {
                        cleanedUp = true;
                    }
                });

                const observed = await observe(async () => {
                    const generator = work() as AsyncGenerator<number> & Partial<AsyncDisposable>;
                    assert.strictEqual(generator[Symbol.asyncIterator](), generator);
                    await generator.next();
                    // The platform defines asyncDispose on the shared prototype in newer runtimes only.
                    if (typeof generator[Symbol.asyncDispose] === "function") await generator[Symbol.asyncDispose]();
                    else await generator.return(undefined);
                });

                assert.strictEqual(cleanedUp, true);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("returns the very generator object the function returned, with the properties the function added to it", async () => {
                const created: unknown[] = [];
                const work = makeTraced(() => {
                    const generator = Object.assign(
                        (function* () {
                            yield 1;
                        })(),
                        { cursor: 7, cancel: () => "canceled" },
                    );
                    created.push(generator);
                    return generator;
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<number> & { cursor: number; cancel(): string };
                    assert.strictEqual(generator, created[0]);
                    assert.strictEqual(generator.cursor, 7);
                    assert.strictEqual(generator.cancel(), "canceled");
                    assert.deepStrictEqual(Object.keys(generator).sort(), ["cancel", "cursor"], "the protocol methods are not enumerable");
                    assert.deepStrictEqual([...generator], [1]);
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps answering like the original generator after it has ended", async () => {
                const syncWork = makeTraced(function* () {
                    yield 1;
                });
                const asyncWork = makeTraced(async function* () {
                    yield 1;
                });

                const observed = await observe(async () => {
                    const sync = syncWork() as Generator<number>;
                    assert.deepStrictEqual([...sync], [1]);
                    assert.deepStrictEqual(sync.next(), { value: undefined, done: true });
                    assert.deepStrictEqual(sync.return(5), { value: 5, done: true });

                    const asynchronous = asyncWork() as AsyncGenerator<number>;
                    for await (const _ of asynchronous) {
                        // Drain it.
                    }
                    assert.deepStrictEqual(await asynchronous.next(), { value: undefined, done: true });
                });

                assert.strictEqual(observed.spans.length, 2, "each span ended once");
            });

            // The result of a traced function can be traced again (a traced function that calls
            // another one and returns its generator): both spans end exactly once, together.
            it("ends the spans of two traced layers over one generator once, when it is exhausted", async () => {
                const inner = makeTraced(function* () {
                    yield 1;
                });
                const outer = makeTraced(() => inner());

                const observed = await observe(async () => {
                    assert.deepStrictEqual([...(outer() as Generator<number>)], [1]);
                });

                assert.strictEqual(observed.spans.length, 2);
                assert.ok(observed.spans.every((span) => span.status.code === SpanStatusCode.UNSET));
            });

            it("leaves a generator with a method that cannot be replaced as it was, and ends the span at once", async () => {
                const work = makeTraced(() => {
                    const generator = (function* () {
                        yield 1;
                    })();
                    Object.defineProperty(generator, "return", { value: generator.return, writable: false, configurable: false });
                    return generator;
                });

                const observed = await observe(async () => {
                    const generator = work() as Generator<number>;
                    assert.ok(!Object.getOwnPropertyNames(generator).includes("next"), "the methods replaced before the failure are put back");
                    assert.deepStrictEqual([...generator], [1]);
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps an optional protocol method absent when the generator object does not have it", async () => {
                const work = makeTraced(() => {
                    const generator = (function* () {
                        yield 1;
                        yield 2;
                    })();
                    Object.defineProperty(generator, "return", { value: undefined, writable: true, configurable: true });
                    return generator;
                });

                await observe(async () => {
                    const generator = work() as Generator<number>;
                    assert.strictEqual(generator.return, undefined);
                    for (const _ of generator) break;
                });
            });

            it("returns a frozen generator as it is and ends the span at once, because it accepts no own methods", async () => {
                const work = makeTraced(() =>
                    Object.freeze(
                        (function* () {
                            yield 1;
                        })(),
                    ),
                );

                const observed = await observe(async () => {
                    assert.deepStrictEqual([...(work() as Generator<number>)], [1]);
                });

                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("returns an array, a Map and a Set untouched and ends the span at once", async () => {
                const array = [1, 2, 3];
                const map = new Map([[1, 2]]);
                const set = new Set([1]);
                for (const value of [array, map, set]) {
                    const work = makeTraced(() => value);
                    let returned: unknown;
                    const observed = await observe(async () => {
                        returned = work();
                    });
                    assert.strictEqual(returned, value);
                    assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
                }
            });

            it("returns a thenable that is not a native Promise as the same object", async () => {
                const thenable = { then: (resolve: (value: string) => void) => resolve("done") };
                const work = makeTraced(() => thenable);
                let returned: unknown;
                await observe(async () => {
                    returned = work();
                });
                assert.strictEqual(returned, thenable);
                assert.deepStrictEqual(Object.keys(thenable), ["then"], "an own enumerable then stays the only enumerable key");
            });
        });
    }
});

describe("span lifetime of a traced thenable", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    /** A thenable that settles after `ms` and says what its `then` was given. */
    function slowThenable(ms: number, outcome: { value: string } | { error: Error }) {
        return {
            then(resolve: (value: string) => void, reject: (error: unknown) => void) {
                setTimeout(() => ("error" in outcome ? reject(outcome.error) : resolve(outcome.value)), ms);
            },
        };
    }

    for (const [label, makeTraced] of [
        ["traced()", <T extends (...args: never[]) => unknown>(fn: T) => traced(fn as never, { name: "work" }) as T],
        ["traceAll()", <T extends (...args: never[]) => unknown>(fn: T) => (traceAll({ work: fn }, { prefix: "Obj" }) as { work: T }).work],
    ] as const) {
        describe(label, () => {
            it("keeps the span open until the thenable settles, then ends it without a status", async () => {
                let span: Span | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return slowThenable(30, { value: "done" });
                });

                let recordingAfterCall: boolean | undefined;
                let value: unknown;
                const observed = await observe(async () => {
                    const pending = work();
                    recordingAfterCall = span?.isRecording();
                    value = await pending;
                });

                assert.strictEqual(value, "done");
                assert.strictEqual(recordingAfterCall, true, "the span is still open when the function has returned");
                assert.strictEqual(span?.isRecording(), false, "the span ends when the thenable resolves");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps the span open while the work of the thenable is running, until the moment it completes", async () => {
                let span: Span | undefined;
                const recordingWhileWorking: boolean[] = [];
                const work = makeTraced(() => {
                    span = activeSpan();
                    return {
                        then(resolve: (value: string) => void) {
                            const tick = setInterval(() => recordingWhileWorking.push(span?.isRecording() ?? false), 5);
                            setTimeout(() => {
                                clearInterval(tick);
                                recordingWhileWorking.push(span?.isRecording() ?? false);
                                resolve("done");
                            }, 40);
                        },
                    };
                });
                await observe(async () => {
                    await work();
                });
                assert.ok(recordingWhileWorking.length >= 3, "the work was sampled several times");
                assert.ok(
                    recordingWhileWorking.every((recording) => recording),
                    "the span is open at every sample, including the last one before the work completes",
                );
                assert.strictEqual(span?.isRecording(), false);
            });

            it("ends the span with ERROR and the message when the thenable rejects, and the caller still gets the rejection", async () => {
                const work = makeTraced(() => slowThenable(5, { error: new Error("thenable boom") }));

                const observed = await observe(async () => {
                    await assert.rejects(Promise.resolve(work()), { message: "thenable boom" });
                });

                const span = onlySpan(observed);
                assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
                assert.strictEqual(span.status.message, "thenable boom");
            });

            it("ends the span with ERROR when the then method throws, and the throw reaches the caller", async () => {
                const work = makeTraced(() => ({
                    then() {
                        throw new Error("then boom");
                    },
                }));

                const observed = await observe(async () => {
                    await assert.rejects(async () => await (work() as PromiseLike<unknown>), { message: "then boom" });
                });

                const span = onlySpan(observed);
                assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
                assert.strictEqual(span.status.message, "then boom");
            });

            it("returns the same object, so the methods of a builder keep working", async () => {
                class Builder {
                    readonly filters: string[] = [];
                    where(filter: string): this {
                        this.filters.push(filter);
                        return this;
                    }
                    then(resolve: (rows: string[]) => void): void {
                        setTimeout(() => resolve([...this.filters]), 5);
                    }
                }
                const builder = new Builder();
                const work = makeTraced(() => builder);

                let returned: unknown;
                let rows: string[] = [];
                const observed = await observe(async () => {
                    returned = work();
                    assert.strictEqual((returned as Builder).where("a"), builder, "a chained method still returns the builder");
                    rows = await (returned as Builder).where("b");
                });

                assert.strictEqual(returned, builder);
                assert.ok(returned instanceof Builder);
                assert.deepStrictEqual(rows, ["a", "b"]);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("runs the work a lazy thenable starts in then under the span of the call", async () => {
                let started = false;
                let parentOfWork: string | undefined;
                const work = makeTraced(() => ({
                    then(resolve: (value: string) => void) {
                        started = true;
                        parentOfWork = childParentId();
                        resolve("rows");
                    },
                }));

                let startedBeforeAwait: boolean | undefined;
                const observed = await observe(async () => {
                    const lazy = work();
                    startedBeforeAwait = started;
                    await lazy;
                });

                assert.strictEqual(startedBeforeAwait, false, "the function returning a thenable does not run it");
                const outer = observed.spans.find((s) => s.name !== "child");
                assert.ok(outer);
                assert.strictEqual(parentOfWork, outer.spanId);
            });

            it("ends the span once and serves every reader when then is called more than once", async () => {
                let calls = 0;
                const work = makeTraced(() => ({
                    then(resolve: (value: number) => void) {
                        calls++;
                        const answer = calls;
                        setTimeout(() => resolve(answer), 5);
                    },
                }));

                let first: unknown;
                let second: unknown;
                const observed = await observe(async () => {
                    const thenable = work() as PromiseLike<number>;
                    first = await thenable;
                    second = await thenable;
                });

                assert.strictEqual(first, 1);
                assert.strictEqual(second, 2, "the second read runs the original then again");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("passes a missing handler through, as the original then does", async () => {
                const work = makeTraced(() => slowThenable(5, { error: new Error("passed on") }));

                await observe(async () => {
                    const thenable = work() as PromiseLike<string>;
                    const settled = await new Promise<{ status: string; reason?: unknown }>((done) => {
                        thenable.then(undefined, (reason) => done({ status: "rejected", reason }));
                    });
                    assert.strictEqual(settled.status, "rejected");
                    assert.strictEqual((settled.reason as Error).message, "passed on");
                });
            });

            it("keeps the span of a thenable open for as long as the caller holds it unread", async () => {
                let span: Span | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return slowThenable(1, { value: "never read" });
                });

                let held: unknown;
                const observed = await observe(async () => {
                    // Held, so the collector cannot end the span while the test looks at it.
                    held = work();
                    await delay(20);
                });

                assert.strictEqual(span?.isRecording(), true);
                assert.strictEqual(observed.spans.length, 0, "an unfinished span is not exported");
                assert.ok(held);
            });

            it("returns a frozen thenable as it is and ends the span at once, because it accepts no own then", async () => {
                const frozen = Object.freeze({ then: (resolve: (value: string) => void) => resolve("done") });
                const work = makeTraced(() => frozen);

                let returned: unknown;
                const observed = await observe(async () => {
                    returned = work();
                    assert.strictEqual(await (returned as PromiseLike<string>), "done");
                });

                assert.strictEqual(returned, frozen);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps the span open while a thenable resolves with a pending promise, and fails it when that promise rejects", async () => {
                let span: Span | undefined;
                let recordingWhenOuterResolved: boolean | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return {
                        then(resolve: (value: unknown) => void) {
                            resolve(
                                delay(20).then(() => {
                                    recordingWhenOuterResolved = span?.isRecording();
                                    throw new Error("nested boom");
                                }),
                            );
                        },
                    };
                });

                const observed = await observe(async () => {
                    await assert.rejects(async () => await (work() as PromiseLike<unknown>), { message: "nested boom" });
                });

                assert.strictEqual(recordingWhenOuterResolved, true);
                const finished = onlySpan(observed);
                assert.strictEqual(finished.status.code, SpanStatusCode.ERROR);
                assert.strictEqual(finished.status.message, "nested boom");
            });

            it("lets the calls that return one unsettled thenable ride along, up to a limit, and the rest end at once", async () => {
                const shared = { then: (resolve: (value: string) => void) => setTimeout(resolve, 5, "shared") };
                const spans: Span[] = [];
                const work = makeTraced(() => {
                    spans.push(activeSpan());
                    return shared;
                });

                const observed = await observe(async () => {
                    for (let call = 0; call < 20_000; call++) work();
                    const riding = spans.filter((span) => span.isRecording());
                    assert.strictEqual(riding.length, 8, "eight spans follow the thenable, the others ended at once");
                    assert.deepStrictEqual(riding, spans.slice(0, 8), "the first calls are the ones that follow");
                    // A layer per call would overflow the stack here.
                    assert.strictEqual(await (shared as unknown as PromiseLike<string>), "shared");
                    assert.ok(
                        riding.every((span) => !span.isRecording()),
                        "all riding spans end with the thenable",
                    );
                });

                assert.strictEqual(observed.spans.length, 20_000);
            });

            it("follows a cached thenable again on the next call once the earlier read has settled", async () => {
                const cached = { then: (resolve: (value: string) => void) => setTimeout(resolve, 5, "cached") };
                const spans: Span[] = [];
                const work = makeTraced(() => {
                    spans.push(activeSpan());
                    return cached;
                });

                const observed = await observe(async () => {
                    work();
                    assert.strictEqual(await (cached as unknown as PromiseLike<string>), "cached");
                    // The first call is over, so the second is not ridden along: it follows by itself.
                    work();
                    assert.strictEqual(spans[1]?.isRecording(), true);
                    assert.strictEqual(await (cached as unknown as PromiseLike<string>), "cached");
                    assert.strictEqual(spans[1]?.isRecording(), false);
                });

                assert.strictEqual(observed.spans.length, 2);
            });

            it("hands arguments after the two handlers to the original then", async () => {
                let extra: unknown[] = [];
                const work = makeTraced(() => ({
                    then(resolve: (value: string) => void, _reject: unknown, ...rest: unknown[]) {
                        extra = rest;
                        resolve("done");
                    },
                }));

                await observe(async () => {
                    const thenable = work() as unknown as { then(...args: unknown[]): void };
                    await new Promise<void>((done) => thenable.then(() => done(), undefined, "progress", 7));
                });

                assert.deepStrictEqual(extra, ["progress", 7]);
            });

            it("treats an object whose then is not a function, or cannot be read, as a plain result", async () => {
                const notCallable = { then: 5 };
                const unreadable = Object.defineProperty({}, "then", {
                    get() {
                        throw new Error("no then for you");
                    },
                });
                for (const value of [notCallable, unreadable]) {
                    const work = makeTraced(() => value);
                    let returned: unknown;
                    const observed = await observe(async () => {
                        returned = work();
                    });
                    assert.strictEqual(returned, value);
                    assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
                }
            });

            it("hands the receiver and every argument of the thenable's callback to the caller's handler", async () => {
                const receiver = { name: "receiver" };
                const work = makeTraced(() => ({
                    then(resolve: (...args: unknown[]) => void) {
                        setTimeout(() => resolve.call(receiver, "value", "metadata"), 5);
                    },
                }));

                let seen: { self: unknown; args: unknown[] } | undefined;
                await observe(async () => {
                    await new Promise<void>((done) => {
                        (work() as PromiseLike<unknown>).then(function (this: unknown, ...args: unknown[]) {
                            seen = { self: this, args };
                            done();
                        });
                    });
                });

                assert.strictEqual(seen?.self, receiver);
                assert.deepStrictEqual(seen?.args, ["value", "metadata"]);
            });

            it("runs the caller's handler in the context of the call to then, not in the finished span's", async () => {
                const work = makeTraced(() => ({
                    then(resolve: (value: string) => void) {
                        setTimeout(() => resolve("done"), 5);
                    },
                }));

                let activeInHandler: Span | undefined = undefined;
                let activeAtSubscription: Span | undefined = undefined;
                await observe(async () => {
                    await trace.getTracer("caller").startActiveSpan("subscriber", async (subscriber) => {
                        activeAtSubscription = subscriber;
                        await new Promise<void>((done) => {
                            (work() as PromiseLike<unknown>).then(() => {
                                activeInHandler = trace.getActiveSpan();
                                done();
                            });
                        });
                        subscriber.end();
                    });
                });

                assert.ok(activeAtSubscription);
                assert.strictEqual(activeInHandler, activeAtSubscription);
            });

            it("ends the span of a native Promise of another realm that its own realm awaits", async () => {
                let span: Span | undefined;
                const realm = createContext({ setTimeout });
                const work = makeTraced(() => {
                    span = activeSpan();
                    return runInContext("(async () => { await new Promise((r) => setTimeout(r, 20)); return 'in-realm'; })()", realm);
                });
                // The consumer is code of the same foreign realm: its await takes the promise
                // directly and never calls a replaced then.
                const consume = runInContext("(async (pending) => await pending)", realm) as (pending: unknown) => Promise<unknown>;

                let value: unknown;
                const observed = await observe(async () => {
                    value = await consume(work());
                });

                assert.strictEqual(value, "in-realm");
                assert.strictEqual(span?.isRecording(), false);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("treats a native Promise of another realm as a promise: the span ends when it settles and a new promise is returned", async () => {
                let span: Span | undefined;
                let foreign: unknown;
                const work = makeTraced(() => {
                    span = activeSpan();
                    foreign = runInNewContext("new Promise((resolve) => setTimeout(resolve, 30, 'foreign'))", { setTimeout });
                    return foreign;
                });

                let recordingAfterCall: boolean | undefined;
                let value: unknown;
                let returned: unknown;
                const observed = await observe(async () => {
                    const pending = work();
                    returned = pending;
                    recordingAfterCall = span?.isRecording();
                    value = await pending;
                });

                assert.strictEqual(value, "foreign");
                // Unlike a thenable, a promise is not kept as the same object: the span is closed by a handler on it.
                assert.notStrictEqual(returned, foreign);
                assert.ok(types.isPromise(returned));
                assert.strictEqual(recordingAfterCall, true);
                assert.strictEqual(span?.isRecording(), false);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });
        });
    }
});

// A generator that the caller keeps (a cursor stored in a field) must not hold the finished
// span, with its attributes and events, and the context of the call, through the methods that
// were put on it.
describe("retention by a kept generator", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    it("no finished span stays reachable through a generator the caller keeps", { timeout: 60_000 }, async () => {
        // Node exposes a collector through a V8 flag, Bun through its own API.
        const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
        let gc: () => void;
        if (bun) {
            gc = () => bun.gc(true);
        } else {
            setFlagsFromString("--expose-gc");
            gc = runInNewContext("gc") as () => void;
        }

        const refs: WeakRef<Span>[] = [];
        // A tracer provider that keeps no span: the collector would otherwise hold every
        // finished span and hide a leak.
        const provider = new BasicTracerProvider({
            spanProcessors: [
                {
                    onStart: (span) => {
                        refs.push(new WeakRef(span as unknown as Span));
                    },
                    onEnd: () => {},
                    forceFlush: async () => {},
                    shutdown: async () => {},
                },
            ],
        });
        await shutdownProvider();
        trace.disable();
        trace.setGlobalTracerProvider(provider);

        const syncWork = traced(function* () {
            yield 1;
        }, { name: "kept-sync" });
        const asyncWork = traced(async function* () {
            yield 1;
        }, { name: "kept-async" });
        // A traced function that returns the generator of another traced function puts two
        // layers on one generator; the outer one must not bring the inner layer back.
        const nestedWork = traced(() => syncWork(), { name: "kept-nested" });
        // The caller keeps every generator until the collector has run.
        const kept: unknown[] = [];
        for (let i = 0; i < 20; i++) {
            const sync = syncWork() as Generator<number>;
            for (const _ of sync) {
                // Drain it.
            }
            const asynchronous = asyncWork() as AsyncGenerator<number>;
            for await (const _ of asynchronous) {
                // Drain it.
            }
            const nested = nestedWork() as Generator<number>;
            for (const _ of nested) {
                // Drain it.
            }
            kept.push(sync, asynchronous, nested);
        }
        trace.disable();
        await provider.shutdown();

        let alive = refs.length;
        for (let attempt = 0; attempt < 20 && alive > 0; attempt++) {
            await nextImmediate();
            await new Promise((resolve) => setTimeout(resolve, 20));
            gc();
            alive = refs.filter((r) => r.deref() !== undefined).length;
        }
        assert.ok(refs.length >= 80, `spans were created (${refs.length})`);
        assert.strictEqual(kept.length, 60, "the generators are still held");
        // JavaScriptCore (Bun) keeps the most recently created object alive from its stack scan,
        // so one survivor is the engine's floor there; V8 must release every span.
        const allowed = bun ? 1 : 0;
        assert.ok(alive <= allowed, `${alive} of ${refs.length} spans are still reachable through the kept generators`);
    });
});

/** Runs the collector until `done()` or the rounds are used up; a finalization callback needs a turn after the collection. */
async function collectUntil(done: () => boolean, rounds = 200): Promise<void> {
    const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
    let gc: () => void;
    if (bun) {
        gc = () => bun.gc(true);
    } else {
        setFlagsFromString("--expose-gc");
        gc = runInNewContext("gc") as () => void;
    }
    for (let round = 0; round < rounds && !done(); round++) {
        gc();
        await delay(10);
    }
}

/** A lazy builder in the shape of Mongoose: `then` and `exec` both run the query, `then` goes through a native promise. */
class MongooseLike {
    readonly filters: string[] = [];
    where(filter: string): this {
        this.filters.push(filter);
        return this;
    }
    exec(): Promise<string[]> {
        return delay(5).then(() => [...this.filters]);
    }
    then(onFulfilled?: (rows: string[]) => unknown, onRejected?: (error: unknown) => unknown) {
        return this.exec().then(onFulfilled, onRejected);
    }
    catch(onRejected: (error: unknown) => unknown) {
        return this.exec().catch(onRejected);
    }
}

/** A builder whose chain methods return a new object, so `then` of the object the function returned is never read. */
class ImmutableBuilder {
    readonly filters: string[];
    constructor(filters: string[] = []) {
        this.filters = filters;
    }
    where(filter: string): ImmutableBuilder {
        return new ImmutableBuilder([...this.filters, filter]);
    }
    then(resolve: (rows: string[]) => void): void {
        setTimeout(resolve, 2, [...this.filters]);
    }
}

describe("thenables that are read in other ways, and several traced layers over one thenable", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    for (const [label, makeTraced] of [
        ["traced()", <T extends (...args: never[]) => unknown>(fn: T) => traced(fn as never, { name: "work" }) as T],
        ["traceAll()", <T extends (...args: never[]) => unknown>(fn: T) => (traceAll({ work: fn }, { prefix: "Obj" }) as { work: T }).work],
    ] as const) {
        describe(label, () => {
            it("marks where the idle time ends: an event on the first read, and none from the collector afterwards", async () => {
                const work = makeTraced(() => new MongooseLike());

                const observed = await observe(async () => {
                    const query = work() as MongooseLike;
                    await delay(30);
                    assert.deepStrictEqual(await query.where("a"), ["a"]);
                    // Settled and unregistered: a collection must not end the span a second time.
                    await collectUntil(() => false, 10);
                });

                const span = onlySpan(observed);
                assert.deepStrictEqual(
                    span.events.map((event) => event.name),
                    ["connectum.result.read"],
                );
            });

            it("puts the thenable back as it was once it has settled, and follows it again on the next call", async () => {
                const ownThen = (resolve: (value: string) => void) => setTimeout(resolve, 2, "own");
                const literal = { then: ownThen };
                const prototyped = new MongooseLike();
                let current: unknown = literal;
                const work = makeTraced(() => current);

                await observe(async () => {
                    work();
                    assert.notStrictEqual(Object.getOwnPropertyDescriptor(literal, "then")?.value, ownThen, "followed while pending");
                    await (literal as unknown as PromiseLike<string>);
                    const restored = Object.getOwnPropertyDescriptor(literal, "then");
                    assert.strictEqual(restored?.value, ownThen);
                    assert.strictEqual(restored?.enumerable, true);

                    current = prototyped;
                    work();
                    assert.strictEqual(Object.hasOwn(prototyped, "then"), true, "followed while pending");
                    await prototyped;
                    assert.strictEqual(Object.hasOwn(prototyped, "then"), false, "the prototype method is back in charge");
                    assert.strictEqual(prototyped.then, MongooseLike.prototype.then);
                });
            });

            it("runs the span a traceAll proxy makes for then once when traced() follows the proxy first", async () => {
        const target = { then: (resolve: (value: string) => void) => setTimeout(resolve, 3, "proxied") };
        const proxy = traceAll(target, { prefix: "P" });
        const work = traced(() => proxy, { name: "work" });

        const observed = await observe(async () => {
            work();
            assert.strictEqual(await (proxy as unknown as PromiseLike<string>), "proxied");
        });

        assert.deepStrictEqual(observed.spans.map((span) => span.name).sort(), ["P.then", "work"]);
    });

    it("takes the first outcome a thenable reports: a rejection after a resolution with a pending promise does not fail the span", async () => {
                const work = makeTraced(() => ({
                    then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
                        resolve(delay(15).then(() => "nested ok"));
                        reject(new Error("too late"));
                    },
                }));

                let value: unknown;
                const observed = await observe(async () => {
                    value = await (work() as PromiseLike<unknown>);
                });

                assert.strictEqual(value, "nested ok");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("keeps the then that a thenable sets for itself while it runs, so a memoized result is not computed twice", async () => {
                class Memoizing {
                    operations = 0;
                    then(onFulfilled?: (v: string) => unknown, onRejected?: (e: unknown) => unknown) {
                        this.operations++;
                        const result = Promise.resolve("computed");
                        // Later reads take the stored result instead of running the operation again.
                        this.then = result.then.bind(result) as Memoizing["then"];
                        return result.then(onFulfilled, onRejected);
                    }
                }
                const memo = new Memoizing();
                const work = makeTraced(() => memo);

                const observed = await observe(async () => {
                    work();
                    assert.strictEqual(await (memo as unknown as PromiseLike<string>), "computed");
                    assert.strictEqual(await (memo as unknown as PromiseLike<string>), "computed");
                });

                assert.strictEqual(memo.operations, 1, "the second read used the then the thenable stored");
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET);
            });

            it("passes a handler the caller left out as missing, and follows the outcome through the promise the thenable returns", async () => {
                const received: string[][] = [];
                const work = makeTraced(() => ({
                    then(onFulfilled?: (v: string) => unknown, onRejected?: (e: unknown) => unknown) {
                        received.push([typeof onFulfilled, typeof onRejected]);
                        return Promise.resolve("rows").then(onFulfilled, onRejected);
                    },
                }));

                const observed = await observe(async () => {
                    const thenable = work() as PromiseLike<string>;
                    // The way a catch(f) reaches then, on a thenable that succeeds.
                    assert.strictEqual(await thenable.then(undefined, () => "failed"), "rows");
                });

                assert.deepStrictEqual(received, [["undefined", "function"]]);
                assert.strictEqual(onlySpan(observed).status.code, SpanStatusCode.UNSET, "the span ended with the success it read from the returned promise");
            });

            it("keeps the span of a callback-style thenable silent when the caller gives no rejection handler", async () => {
                const uncaught: unknown[] = [];
                const onUncaught = (error: unknown) => uncaught.push(error);
                process.on("uncaughtException", onUncaught);
                try {
                    let span: Span | undefined;
                    const work = makeTraced(() => {
                        span = activeSpan();
                        return {
                            // Reports a failure only to a handler it was given, as many callback APIs do.
                            then(_resolve: unknown, reject?: (error: unknown) => void) {
                                setTimeout(() => {
                                    if (typeof reject === "function") reject(new Error("db down"));
                                }, 5);
                            },
                        };
                    });
                    let held: unknown;
                    await observe(async () => {
                        held = work();
                        (held as PromiseLike<unknown>).then(() => {});
                        await delay(40);
                    });
                    assert.deepStrictEqual(uncaught, [], "tracing must not turn a silent thenable into a crash");
                    assert.strictEqual(span?.isRecording(), true, "a failure nobody reported is not seen; the collector ends the span later");
                    assert.ok(held);
                } finally {
                    process.off("uncaughtException", onUncaught);
                }
            });

            it("passes a failure on unchanged and ends the span with ERROR for a thenable that returns a native promise, with no handler of the caller", async () => {
                const unhandled: unknown[] = [];
                const onUnhandled = (reason: unknown) => unhandled.push(reason);
                process.on("unhandledRejection", onUnhandled);
                try {
                    const work = makeTraced(() => ({
                        then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                            return Promise.reject(new Error("promise-backed boom")).then(onFulfilled, onRejected);
                        },
                    }));

                    let caught: unknown;
                    const observed = await observe(async () => {
                        const derived = (work() as PromiseLike<unknown>).then(() => "never");
                        await (derived as Promise<unknown>).then(undefined, (error) => {
                            caught = error;
                        });
                        await delay(10);
                    });

                    assert.strictEqual((caught as Error).message, "promise-backed boom");
                    assert.deepStrictEqual(unhandled, [], "the caller handled the rejection, so nothing is unhandled");
                    const span = onlySpan(observed);
                    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
                    assert.strictEqual(span.status.message, "promise-backed boom");
                } finally {
                    process.off("unhandledRejection", onUnhandled);
                }
            });

            it("covers a promise-backed builder read with await, then(f, g) and catch(f), in the form real libraries have", async () => {
                class Failing extends MongooseLike {
                    override exec(): Promise<string[]> {
                        return delay(5).then(() => {
                            throw new Error("exec boom");
                        });
                    }
                    // Knex-like: catch goes through then.
                    override catch(onRejected: (error: unknown) => unknown) {
                        return this.then(undefined, onRejected);
                    }
                }
                const ok = makeTraced(() => new MongooseLike());
                const failing = makeTraced(() => new Failing());

                const observed = await observe(async () => {
                    assert.deepStrictEqual(await (ok() as MongooseLike).where("a"), ["a"]);
                    await (ok() as MongooseLike).then(
                        (rows) => assert.deepStrictEqual(rows, []),
                        () => assert.fail("must not reject"),
                    );
                    await (failing() as Failing).catch((error) => assert.strictEqual((error as Error).message, "exec boom"));
                });

                assert.strictEqual(observed.spans.length, 3);
                assert.deepStrictEqual(observed.spans.map((span) => span.status.code).sort(), [SpanStatusCode.UNSET, SpanStatusCode.UNSET, SpanStatusCode.ERROR].sort());
            });

            it("ends the span of a builder consumed through exec() when the collector takes the builder, marked as unread", { timeout: 60_000 }, async () => {
                let span: Span | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return new MongooseLike();
                });

                const observed = await observe(async () => {
                    // The builder is out of reach once this function has returned.
                    const rows = await (async () => (work() as MongooseLike).where("a").exec())();
                    assert.deepStrictEqual(rows, ["a"]);
                    assert.strictEqual(span?.isRecording(), true, "exec() never calls then, so nothing has ended the span yet");
                    await collectUntil(() => span?.isRecording() === false);
                });

                assert.strictEqual(span?.isRecording(), false, "the collector ended the span");
                const finished = onlySpan(observed);
                assert.strictEqual(finished.status.code, SpanStatusCode.UNSET);
                assert.deepStrictEqual(
                    finished.events.map((event) => event.name),
                    ["connectum.result.unread"],
                );
            });

            it("still lets the collector take a builder that the context of its own call reaches", { timeout: 60_000 }, async () => {
                let span: Span | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return new MongooseLike();
                });
                const requestKey = createContextKey("request");

                await observe(async () => {
                    await (async () => {
                        // The context of the call holds an object that holds the builder, as a request
                        // object that keeps its queries would.
                        const request: { query?: MongooseLike } = {};
                        await context.with(context.active().setValue(requestKey, request), async () => {
                            request.query = (work() as MongooseLike).where("a");
                            await request.query.exec();
                        });
                    })();
                    await collectUntil(() => span?.isRecording() === false);
                });

                assert.strictEqual(span?.isRecording(), false, "the registry must not keep the context, and through it the builder, alive");
            });

            it("ends the span of an immutable builder through the collector: the object that was read is not the one the function returned", { timeout: 60_000 }, async () => {
                let span: Span | undefined;
                const work = makeTraced(() => {
                    span = activeSpan();
                    return new ImmutableBuilder();
                });

                const observed = await observe(async () => {
                    const rows = await (async () => await (work() as ImmutableBuilder).where("a"))();
                    assert.deepStrictEqual(rows, ["a"]);
                    await collectUntil(() => span?.isRecording() === false);
                });

                assert.strictEqual(span?.isRecording(), false);
                assert.deepStrictEqual(
                    onlySpan(observed).events.map((event) => event.name),
                    ["connectum.result.unread"],
                );
            });
        });
    }

    it("lets every layer cover the work when traced functions return the thenable one from another", async () => {
        const sampled: Record<string, boolean[]> = { outer: [], inner: [] };
        let outerSpan: Span | undefined;
        let innerSpan: Span | undefined;
        const inner = traced(
            () => {
                innerSpan = activeSpan();
                return {
                    then(resolve: (value: string) => void) {
                        setTimeout(() => {
                            sampled.outer?.push(outerSpan?.isRecording() ?? false);
                            sampled.inner?.push(innerSpan?.isRecording() ?? false);
                            resolve("rows");
                        }, 30);
                    },
                };
            },
            { name: "inner" },
        );
        const outer = traced(
            () => {
                outerSpan = activeSpan();
                return inner();
            },
            { name: "outer" },
        );

        let value: unknown;
        const observed = await observe(async () => {
            const pending = outer();
            assert.strictEqual(outerSpan?.isRecording(), true, "the outer span does not end when the function returns");
            value = await pending;
        });

        assert.strictEqual(value, "rows");
        assert.deepStrictEqual(sampled, { outer: [true], inner: [true] }, "both spans are open until the work completes");
        assert.strictEqual(outerSpan?.isRecording(), false);
        assert.strictEqual(innerSpan?.isRecording(), false);
        assert.strictEqual(observed.spans.length, 2);
    });

    it("lets a traceAll layer over a service cover the work of a traceAll layer over a repository that it passes through", async () => {
        let started = 0;
        const repository = traceAll(
            {
                find: () => ({
                    then(resolve: (value: string) => void) {
                        started++;
                        setTimeout(resolve, 20, "rows");
                    },
                }),
            },
            { prefix: "Repo" },
        );
        const service = traceAll({ users: () => repository.find() }, { prefix: "Service" });

        const observed = await observe(async () => {
            const pending = service.users() as PromiseLike<string>;
            assert.strictEqual(started, 0, "still lazy");
            assert.strictEqual(await pending, "rows");
        });

        assert.strictEqual(started, 1);
        const spans = new Map(observed.spans.map((span) => [span.name, span]));
        assert.deepStrictEqual([...spans.keys()].sort(), ["Repo.find", "Service.users"]);
        assert.strictEqual(spans.get("Repo.find")?.parentSpanId, spans.get("Service.users")?.spanId, "the repository span is a child of the service span");
        assert.deepStrictEqual(
            spans.get("Service.users")?.events.map((event) => event.name),
            ["connectum.result.read"],
            "the outer span is a follower of the same thenable and was marked as read",
        );
    });

    it("leaves a thenable whose then is a getter as it is: the getter keeps being read on every use", async () => {
        let reads = 0;
        class Snapshotting {
            value = "first";
            get then() {
                reads++;
                const snapshot = this.value;
                return (resolve: (value: string) => void) => resolve(snapshot);
            }
        }
        const builder = new Snapshotting();
        let span: Span | undefined;
        const work = traced(
            () => {
                span = activeSpan();
                return builder;
            },
            { name: "work" },
        );

        const observed = await observe(async () => {
            work();
            assert.strictEqual(span?.isRecording(), false, "a getter is not followed, so the span ends at once");
            assert.strictEqual(reads, 0, "the getter is not even read when the function returns");
            builder.value = "second";
            assert.strictEqual(await (builder as unknown as PromiseLike<string>), "second", "the state at the time of the read counts");
        });

        assert.strictEqual(observed.spans.length, 1);
    });

    it("closes each unread span at the moment its own function returned, whatever order the calls come in", { timeout: 60_000 }, async () => {
        const spans: Span[] = [];

        // The SDK reports an end time before the start time through the diagnostics channel.
        const warnings: string[] = [];
        const observed = await observe(async () => {
            // The first traced call creates the provider, and that resets the diagnostics logger:
            // make it first, set the logger after.
            traced(() => 0, { name: "warm-up" })();
            diag.setLogger(
                { verbose() {}, debug() {}, info() {}, error() {}, warn: (message: string) => warnings.push(message) },
                DiagLogLevel.WARN,
            );
            // The builder is reachable only through this function's locals once it has returned.
            await (async () => {
                const local = new MongooseLike();
                const again = traced(
                    () => {
                        spans.push(activeSpan());
                        return local;
                    },
                    { name: "again" },
                );
                again();
                await delay(25);
                again();
            })();
            await collectUntil(() => spans.every((span) => !span.isRecording()));
            diag.disable();
        });

        assert.strictEqual(spans.length, 2);
        assert.ok(spans.every((span) => !span.isRecording()));
        assert.deepStrictEqual(
            observed.spans.filter((span) => span.name === "again").map((span) => span.events.map((event) => event.name)),
            [["connectum.result.unread"], ["connectum.result.unread"]],
        );
        assert.deepStrictEqual(
            warnings.filter((message) => message.includes("Inconsistent start and end time")),
            [],
        );
    });

    it("changes a thenable that a traceAll method returns only until it settles, and adds no layer when the proxy is returned again", async () => {
        class Query {
            then(resolve: (value: string) => void) {
                setTimeout(resolve, 5, "q");
            }
            self() {
                return this;
            }
        }
        const target = new Query();
        const proxy = traceAll(target, { prefix: "Q" });
        const spans: Span[] = [];
        const work = traced(
            () => {
                spans.push(activeSpan());
                return proxy;
            },
            { name: "work" },
        );

        const observed = await observe(async () => {
            const returned = proxy.self();
            assert.strictEqual(returned, target, "a method that returns this hands out the target");
            assert.strictEqual(Object.hasOwn(target, "then"), true, "followed while pending");
            for (let call = 0; call < 20_000; call++) work();
            // Every read of then on the proxy is a new function; a layer per call would overflow the stack here.
            assert.strictEqual(await (proxy as unknown as PromiseLike<string>), "q");
            assert.strictEqual(Object.hasOwn(target, "then"), false, "the target is as it was once it has settled");
        });

        assert.strictEqual(spans.filter((span) => span.isRecording()).length, 0);
        assert.strictEqual(observed.spans.filter((span) => span.name === "work").length, 20_000);
        assert.strictEqual(observed.spans.filter((span) => span.name === "Q.then").length, 1, "the proxy's own span for then is not run a second time under ours");
    });
});
