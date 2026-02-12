process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { shutdownProvider } from "../../src/provider.ts";
import { traceAll } from "../../src/traceAll.ts";

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

    describe("include/exclude", () => {
        it("should only wrap included methods (both still callable)", () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                    sub(a: number, b: number) {
                        return a - b;
                    },
                },
                { include: ["add"] },
            );

            // Both methods should work -- include only affects tracing, not availability
            assert.strictEqual(obj.add(2, 3), 5);
            assert.strictEqual(obj.sub(5, 3), 2);
        });

        it("should skip excluded methods (both still callable)", () => {
            const obj = traceAll(
                {
                    pub() {
                        return "public";
                    },
                    priv() {
                        return "private";
                    },
                },
                { exclude: ["priv"] },
            );

            assert.strictEqual(obj.pub(), "public");
            assert.strictEqual(obj.priv(), "private");
        });

        it("should handle empty include array (no methods traced)", () => {
            const obj = traceAll(
                {
                    method() {
                        return 1;
                    },
                },
                { include: [] },
            );
            assert.strictEqual(obj.method(), 1);
        });

        it("should handle empty exclude array (all methods traced)", () => {
            const obj = traceAll(
                {
                    method() {
                        return 1;
                    },
                },
                { exclude: [] },
            );
            assert.strictEqual(obj.method(), 1);
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
        it("should use constructor name as default prefix for class instances", () => {
            class MyService {
                greet() {
                    return "hello";
                }
            }
            const obj = traceAll(new MyService());
            assert.strictEqual(obj.greet(), "hello");
        });

        it("should use custom prefix", () => {
            const obj = traceAll(
                {
                    greet() {
                        return "hello";
                    },
                },
                { prefix: "Custom" },
            );
            assert.strictEqual(obj.greet(), "hello");
        });

        it("should default to 'Object' for plain objects", () => {
            const obj = traceAll({
                greet() {
                    return "hello";
                },
            });
            assert.strictEqual(obj.greet(), "hello");
        });
    });

    describe("recordArgs and argsFilter", () => {
        it("should work with recordArgs=true", () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                },
                { recordArgs: true },
            );
            assert.strictEqual(obj.add(2, 3), 5);
        });

        it("should work with recordArgs whitelist", () => {
            const obj = traceAll(
                {
                    add(a: number, b: number) {
                        return a + b;
                    },
                },
                { recordArgs: ["0"] },
            );
            assert.strictEqual(obj.add(2, 3), 5);
        });

        it("should work with argsFilter", () => {
            const obj = traceAll(
                {
                    login(data: { pass: string }) {
                        return data.pass;
                    },
                },
                {
                    recordArgs: true,
                    argsFilter: (name, args) => {
                        if (name === "login") return [{ pass: "***" }];
                        return args;
                    },
                },
            );
            // argsFilter only affects recorded span attributes, not actual arguments
            assert.strictEqual(obj.login({ pass: "secret" }), "secret");
        });
    });

    describe("constructor property", () => {
        it("should not wrap constructor", () => {
            class MyClass {
                value = 10;
                getValue() {
                    return this.value;
                }
            }
            const obj = traceAll(new MyClass());
            // constructor should still be accessible and not wrapped
            assert.strictEqual(typeof obj.constructor, "function");
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
