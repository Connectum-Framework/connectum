process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { shutdownProvider } from "../../src/provider.ts";
import { traceAll } from "../../src/traceAll.ts";
import { observe } from "./observe.ts";

/** Runs a body and returns the names of the spans it produced, sorted. */
async function spanNamesOf(body: () => unknown): Promise<string[]> {
    const observed = await observe(async () => {
        await body();
    });
    return observed.spans.map((span) => span.name).sort();
}

/** Runs a body and returns the one `function.args` value it recorded, or undefined when none was recorded. */
async function recordedArgsOf(body: () => unknown): Promise<unknown> {
    const observed = await observe(async () => {
        await body();
    });
    assert.strictEqual(observed.spans.length, 1, "expected exactly one span");
    return observed.spans[0]?.attributes["function.args"];
}

describe("traceAll", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    describe("basic wrapping", () => {
        it("should wrap object methods and return results", () => {
            const obj = traceAll({
                add(a: number, b: number) {
                    return a + b;
                },
                multiply(a: number, b: number) {
                    return a * b;
                },
            });
            assert.strictEqual(obj.add(2, 3), 5);
            assert.strictEqual(obj.multiply(2, 3), 6);
        });

        it("should wrap async methods", async () => {
            const obj = traceAll({
                async fetch(id: number) {
                    return { id };
                },
            });
            const result = await obj.fetch(42);
            assert.deepStrictEqual(result, { id: 42 });
        });

        it("should not wrap non-function properties", () => {
            const obj = traceAll({ value: 42, label: "test" });
            assert.strictEqual(obj.value, 42);
            assert.strictEqual(obj.label, "test");
        });

        it("should handle mixed function and non-function properties", () => {
            const obj = traceAll({
                count: 0,
                increment() {
                    return 1;
                },
            });
            assert.strictEqual(obj.count, 0);
            assert.strictEqual(obj.increment(), 1);
        });
    });

    describe("span status", () => {
        // Instrumentation never reports OK: success keeps the default UNSET status and
        // only a failure sets ERROR with the error message.
        it("should leave the status unset when a sync method returns", async () => {
            const obj = traceAll({ one: () => 1 });

            const spans = (await observe(async () => void obj.one())).spans;

            assert.strictEqual(spans.length, 1);
            assert.strictEqual(spans[0]?.status.code, SpanStatusCode.UNSET);
        });

        it("should leave the status unset when an async method resolves", async () => {
            const obj = traceAll({ one: async () => 1 });

            const spans = (await observe(async () => void (await obj.one()))).spans;

            assert.strictEqual(spans.length, 1);
            assert.strictEqual(spans[0]?.status.code, SpanStatusCode.UNSET);
        });

        it("should set ERROR with the message when a sync method throws", async () => {
            const obj = traceAll({
                fail(): number {
                    throw new Error("sync boom");
                },
            });

            const spans = (await observe(async () => assert.throws(() => obj.fail(), { message: "sync boom" }))).spans;

            assert.strictEqual(spans.length, 1);
            assert.strictEqual(spans[0]?.status.code, SpanStatusCode.ERROR);
            assert.strictEqual(spans[0]?.status.message, "sync boom");
        });

        it("should set ERROR with the message when an async method rejects", async () => {
            const obj = traceAll({
                async fail(): Promise<number> {
                    throw new Error("async boom");
                },
            });

            const spans = (await observe(() => assert.rejects(() => obj.fail(), { message: "async boom" }))).spans;

            assert.strictEqual(spans.length, 1);
            assert.strictEqual(spans[0]?.status.code, SpanStatusCode.ERROR);
            assert.strictEqual(spans[0]?.status.message, "async boom");
        });

        it("should leave the status unset when the consumer stops reading a returned stream early", async () => {
            const obj = traceAll({
                async *numbers() {
                    yield 1;
                    yield 2;
                },
            });

            const spans = (
                await observe(async () => {
                    for await (const _value of obj.numbers()) {
                        break;
                    }
                })
            ).spans;

            assert.strictEqual(spans.length, 1);
            assert.strictEqual(spans[0]?.status.code, SpanStatusCode.UNSET);
        });
    });

    describe("error handling", () => {
        it("should propagate sync errors", () => {
            const obj = traceAll({
                fail() {
                    throw new Error("sync fail");
                },
            });
            assert.throws(() => obj.fail(), { message: "sync fail" });
        });

        it("should propagate async errors", async () => {
            const obj = traceAll({
                async fail() {
                    throw new Error("async fail");
                },
            });
            await assert.rejects(() => obj.fail(), { message: "async fail" });
        });
    });

    // Each traced call produces one span named "<prefix>.<method>"; an untraced call produces none.
    describe("include/exclude", () => {
        it("should only trace included methods, leaving the others callable", async () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                    sub(a: number, b: number) {
                        return a - b;
                    },
                },
                { include: ["add"], prefix: "Calc" },
            );
            const results: number[] = [];

            const names = await spanNamesOf(() => {
                results.push(obj.add(2, 3), obj.sub(5, 3));
            });

            assert.deepStrictEqual(results, [5, 2]);
            assert.deepStrictEqual(names, ["Calc.add"]);
        });

        it("should skip excluded methods, leaving them callable", async () => {
            const obj = traceAll(
                {
                    pub() {
                        return "public";
                    },
                    priv() {
                        return "private";
                    },
                },
                { exclude: ["priv"], prefix: "Svc" },
            );
            const results: string[] = [];

            const names = await spanNamesOf(() => {
                results.push(obj.pub(), obj.priv());
            });

            assert.deepStrictEqual(results, ["public", "private"]);
            assert.deepStrictEqual(names, ["Svc.pub"]);
        });

        it("should trace no method when include is an empty list", async () => {
            const obj = traceAll(
                {
                    method() {
                        return 1;
                    },
                },
                { include: [] },
            );
            let result: number | undefined;

            const names = await spanNamesOf(() => {
                result = obj.method();
            });

            assert.strictEqual(result, 1);
            assert.deepStrictEqual(names, []);
        });

        it("should trace every method when exclude is an empty list", async () => {
            const obj = traceAll(
                {
                    method() {
                        return 1;
                    },
                },
                { exclude: [], prefix: "All" },
            );
            let result: number | undefined;

            const names = await spanNamesOf(() => {
                result = obj.method();
            });

            assert.strictEqual(result, 1);
            assert.deepStrictEqual(names, ["All.method"]);
        });
    });

    describe("no prototype mutation", () => {
        it("should not mutate original object", () => {
            const original = {
                method() {
                    return 1;
                },
            };
            const originalMethod = original.method;
            traceAll(original);
            assert.strictEqual(original.method, originalMethod);
        });

        it("should return a different reference (Proxy)", () => {
            const original = {
                method() {
                    return 1;
                },
            };
            const proxied = traceAll(original);
            assert.notStrictEqual(proxied, original);
        });
    });

    describe("double-wrapping prevention", () => {
        it("should return same proxy on double wrap", () => {
            const obj = {
                method() {
                    return 1;
                },
            };
            const wrapped = traceAll(obj);
            const doubleWrapped = traceAll(wrapped);
            assert.strictEqual(wrapped, doubleWrapped);
        });
    });

    describe("prefix", () => {
        it("should use constructor name as default prefix for class instances", async () => {
            class MyService {
                greet() {
                    return "hello";
                }
            }
            const obj = traceAll(new MyService());
            let result: string | undefined;

            const names = await spanNamesOf(() => {
                result = obj.greet();
            });

            assert.strictEqual(result, "hello");
            assert.deepStrictEqual(names, ["MyService.greet"]);
        });

        it("should use custom prefix", async () => {
            const obj = traceAll(
                {
                    greet() {
                        return "hello";
                    },
                },
                { prefix: "Custom" },
            );
            let result: string | undefined;

            const names = await spanNamesOf(() => {
                result = obj.greet();
            });

            assert.strictEqual(result, "hello");
            assert.deepStrictEqual(names, ["Custom.greet"]);
        });

        it("should default to 'Object' for plain objects", async () => {
            const obj = traceAll({
                greet() {
                    return "hello";
                },
            });
            let result: string | undefined;

            const names = await spanNamesOf(() => {
                result = obj.greet();
            });

            assert.strictEqual(result, "hello");
            assert.deepStrictEqual(names, ["Object.greet"]);
        });
    });

    // The tracing guide: `recordArgs: true` serializes the arguments into the `function.args`
    // span attribute, an array selects zero-based argument positions, and `argsFilter`
    // redacts what is recorded.
    describe("recordArgs and argsFilter", () => {
        it("records no function.args by default", async () => {
            const obj = traceAll({
                add(a: number, b: number) {
                    return a + b;
                },
            });

            assert.strictEqual(await recordedArgsOf(() => obj.add(2, 3)), undefined);
        });

        it("records the serialized arguments with recordArgs=true", async () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                },
                { recordArgs: true },
            );
            let result: number | undefined;

            const recorded = await recordedArgsOf(() => {
                result = obj.add(2, 3);
            });

            assert.strictEqual(result, 5);
            assert.strictEqual(recorded, "[2,3]");
        });

        it("records only the arguments at the listed positions", async () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                },
                { recordArgs: ["1"] },
            );
            let result: number | undefined;

            const recorded = await recordedArgsOf(() => {
                result = obj.add(2, 3);
            });

            assert.strictEqual(result, 5);
            assert.strictEqual(recorded, "[3]");
        });

        it("masks the recorded arguments with argsFilter, which also receives the method name", async () => {
            const seenMethods: string[] = [];
            const obj = traceAll(
                {
                    login(data: { pass: string }) {
                        return data.pass;
                    },
                },
                {
                    recordArgs: true,
                    argsFilter: (name, args) => {
                        seenMethods.push(name);
                        if (name === "login") return [{ pass: "***" }];
                        return args;
                    },
                },
            );
            let result: string | undefined;

            const observed = await observe(async () => {
                result = obj.login({ pass: "secret" });
            });

            assert.strictEqual(result, "secret", "argsFilter only affects the recorded attribute, not the actual arguments");
            assert.deepStrictEqual(seenMethods, ["login"]);
            assert.strictEqual(observed.spans[0]?.attributes["function.args"], '[{"pass":"***"}]');
            assert.ok(!JSON.stringify(observed.spans).includes("secret"), "the secret does not appear anywhere in the exported span");
        });
    });

    describe("constructor property", () => {
        it("should not wrap constructor", async () => {
            class MyClass {
                value = 10;
                getValue() {
                    return this.value;
                }
            }
            const obj = traceAll(new MyClass());
            let constructorOfProxy: unknown;

            const names = await spanNamesOf(() => {
                constructorOfProxy = obj.constructor;
            });

            assert.strictEqual(constructorOfProxy, MyClass, "reading constructor yields the class itself, not a traced wrapper");
            assert.deepStrictEqual(names, []);
        });
    });

    describe("symbol keys", () => {
        it("should not wrap symbol-keyed methods", () => {
            const sym = Symbol("test");
            const obj = traceAll({
                [sym]() {
                    return "symbol";
                },
                regular() {
                    return "regular";
                },
            });
            // Symbol method should still work (returned as-is, not traced)
            const symFn = (obj as Record<symbol, (() => string) | undefined>)[sym];
            assert.ok(symFn);
            assert.strictEqual(symFn(), "symbol");
            assert.strictEqual(obj.regular(), "regular");
        });
    });

    // A traced object must behave like the original object for every property read:
    // the proxy only adds spans around methods, it never changes what a property holds.
    describe("transparency of property reads", () => {
        it("should read a getter over a #private field", () => {
            class Counter {
                #n = 42;
                get n() {
                    return this.#n;
                }
            }
            assert.strictEqual(traceAll(new Counter()).n, 42);
        });

        it("should read Map.size and keep the Map methods working", () => {
            const map = traceAll(new Map([[1, 2]]));
            assert.strictEqual(map.size, 1);
            assert.strictEqual(map.get(1), 2);
        });

        it("should read the accessors of a Set and a Date through the proxy", () => {
            assert.strictEqual(traceAll(new Set([1, 2])).size, 2);
            assert.strictEqual(traceAll(new Date(0)).getTime(), 0);
        });

        it("should call the method of a frozen object and return its result", () => {
            const frozen = traceAll(
                Object.freeze({
                    greet() {
                        return "hi";
                    },
                }),
            );
            assert.strictEqual(frozen.greet(), "hi");
        });

        it("should return the original function for a non-writable, non-configurable method, so the proxy invariant holds", () => {
            const method = () => "hi";
            const target = Object.freeze({ method });
            assert.strictEqual(traceAll(target).method, method);
        });

        it("should still trace a method defined as a non-configurable but writable property", async () => {
            const target = {};
            Object.defineProperty(target, "work", { value: () => "done", writable: true, configurable: false });
            const names = await spanNamesOf(() => (traceAll(target) as { work(): string }).work());
            assert.deepStrictEqual(names, ["Object.work"]);
        });

        it("should keep tracing the methods of a class instance whose getter reads a #private field", async () => {
            class Repository {
                #rows = [1, 2, 3];
                get count() {
                    return this.#rows.length;
                }
                load() {
                    return this.#rows.slice();
                }
            }
            const repository = traceAll(new Repository());
            assert.strictEqual(repository.count, 3);
            const names = await spanNamesOf(() => repository.load());
            assert.deepStrictEqual(names, ["Repository.load"]);
        });
    });
});
