/**
 * scopeAsyncIterable(): every step of an iterator runs in the given context
 * and the context never outlives the step.
 */

process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import { type Context, context, createContextKey } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { scopeAsyncIterable } from "../../src/shared.ts";

const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

const KEY = createContextKey("scope-async-iterable-test");
const marked = (value: string): Context => context.active().setValue(KEY, value);
const current = () => context.active().getValue(KEY);

/** An iterable whose iterator records the context value at every protocol call. */
function recordingIterable(seen: Array<[string, unknown]>, options: { withReturn?: boolean; withThrow?: boolean } = {}): AsyncIterable<number> {
    const { withReturn = true, withThrow = true } = options;
    return {
        [Symbol.asyncIterator]() {
            seen.push(["create", current()]);
            let n = 0;
            const iterator: AsyncIterator<number> = {
                async next(...args: [] | [undefined]) {
                    seen.push(["next", current()]);
                    seen.push(["next-args", args.length]);
                    await Promise.resolve();
                    seen.push(["next-after-await", current()]);
                    return { value: n++, done: false };
                },
            };
            if (withReturn) {
                iterator.return = async (value?: unknown) => {
                    seen.push(["return", current()]);
                    return { value, done: true };
                };
            }
            if (withThrow) {
                iterator.throw = async (error?: unknown) => {
                    seen.push(["throw", current()]);
                    throw error;
                };
            }
            return iterator;
        },
    };
}

describe("scopeAsyncIterable", () => {
    it("creates the iterator and runs next, return and throw in the scope", async () => {
        const seen: Array<[string, unknown]> = [];
        const iterator = scopeAsyncIterable(recordingIterable(seen), marked("scope"))[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.return?.();
        await assert.rejects(async () => iterator.throw?.(new Error("boom")), /boom/);
        const byName = Object.fromEntries(seen.filter(([name]) => name !== "next-args"));
        assert.deepStrictEqual(byName, {
            create: "scope",
            next: "scope",
            "next-after-await": "scope",
            return: "scope",
            throw: "scope",
        });
    });

    it("leaves the caller's own context in place around and after every step", async () => {
        const seen: Array<[string, unknown]> = [];
        const iterator = scopeAsyncIterable(recordingIterable(seen), marked("scope"))[Symbol.asyncIterator]();
        await context.with(marked("caller"), async () => {
            const pending = iterator.next();
            assert.strictEqual(current(), "caller", "synchronously after the call");
            await pending;
            assert.strictEqual(current(), "caller", "after awaiting the step");
            await iterator.return?.();
            assert.strictEqual(current(), "caller", "after return");
        });
        assert.strictEqual(current(), undefined, "outside the caller's scope nothing is left behind");
    });

    it("forwards the argument of next() and the value of return()", async () => {
        const seen: Array<[string, unknown]> = [];
        const iterator = scopeAsyncIterable(recordingIterable(seen), marked("scope"))[Symbol.asyncIterator]();
        await iterator.next(undefined);
        const returned = await iterator.return?.("done-value");
        assert.deepStrictEqual(returned, { value: "done-value", done: true });
        assert.deepStrictEqual(
            seen.find(([name]) => name === "next-args"),
            ["next-args", 1],
        );
    });

    it("mirrors the absence of return and throw", () => {
        const iterator = scopeAsyncIterable(recordingIterable([], { withReturn: false, withThrow: false }), marked("scope"))[Symbol.asyncIterator]();
        assert.strictEqual(iterator.return, undefined);
        assert.strictEqual(iterator.throw, undefined);
    });

    it("runs an async generator body, including its finally, in the scope", async () => {
        const seen: unknown[] = [];
        async function* body() {
            try {
                seen.push(current());
                await Promise.resolve();
                seen.push(current());
                yield 1;
                seen.push(current());
                yield 2;
            } finally {
                seen.push(current());
            }
        }
        const scoped = scopeAsyncIterable(body(), marked("scope"));
        for await (const value of scoped) {
            if (value === 1) continue;
        }
        const early = scopeAsyncIterable(body(), marked("scope-early"));
        for await (const _ of early) break;
        assert.deepStrictEqual(seen, ["scope", "scope", "scope", "scope", "scope-early", "scope-early", "scope-early"]);
    });

    it("keeps concurrent iterators in their own scopes", async () => {
        const seen = new Map<string, unknown[]>();
        async function* body(tag: string) {
            const list: unknown[] = [];
            seen.set(tag, list);
            for (let i = 0; i < 3; i++) {
                await new Promise((resolve) => setTimeout(resolve, 1));
                list.push(current());
                yield i;
            }
        }
        await Promise.all(
            ["a", "b", "c", "d"].map(async (tag) => {
                for await (const _ of scopeAsyncIterable(body(tag), marked(tag))) {
                    /* drain */
                }
            }),
        );
        for (const [tag, list] of seen) assert.deepStrictEqual(list, [tag, tag, tag]);
    });
});
