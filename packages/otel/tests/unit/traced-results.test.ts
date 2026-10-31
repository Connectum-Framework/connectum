/**
 * What a traced function returns decides when its span ends.
 *
 * A generator function returns before any of its body has run, so a span that ends
 * when the function returns has zero duration and covers nothing. These tests pin that
 * the span of a `traced()` function and of a `traceAll()` method stays open while the
 * caller iterates the generator, that the generator body runs with the span active,
 * that failures and early exits end it correctly, and that results which are not
 * generators (arrays, maps, non-native thenables) are returned untouched.
 */

process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay, setImmediate as nextImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
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

            it("returns a thenable that is not a native Promise as it is", async () => {
                const thenable = { then: (resolve: (value: string) => void) => resolve("done") };
                const work = makeTraced(() => thenable);
                let returned: unknown;
                await observe(async () => {
                    returned = work();
                });
                assert.strictEqual(returned, thenable);
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
