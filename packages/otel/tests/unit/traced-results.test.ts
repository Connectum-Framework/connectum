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
import { setTimeout as delay } from "node:timers/promises";
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
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
