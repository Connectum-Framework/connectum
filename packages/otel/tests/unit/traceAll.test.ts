process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
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
});
