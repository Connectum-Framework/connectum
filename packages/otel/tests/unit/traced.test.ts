process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { shutdownProvider } from "../../src/provider.ts";
import { traced } from "../../src/traced.ts";

describe("traced", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    describe("sync functions", () => {
        it("should wrap sync function and return result", () => {
            const add = traced((a: number, b: number) => a + b, { name: "add" });
            assert.strictEqual(add(2, 3), 5);
        });

        it("should propagate sync errors", () => {
            const fail = traced(
                () => {
                    throw new Error("sync fail");
                },
                { name: "fail" },
            );
            assert.throws(() => fail(), { message: "sync fail" });
        });
    });

    describe("async functions", () => {
        it("should wrap async function and return result", async () => {
            const asyncAdd = traced(async (a: number, b: number) => a + b, { name: "asyncAdd" });
            assert.strictEqual(await asyncAdd(2, 3), 5);
        });

        it("should propagate async errors", async () => {
            const asyncFail = traced(
                async () => {
                    throw new Error("async fail");
                },
                { name: "asyncFail" },
            );
            await assert.rejects(() => asyncFail(), { message: "async fail" });
        });
    });

    describe("options", () => {
        it("should use function name as default span name", () => {
            function myFunc() {
                return 42;
            }
            const wrapped = traced(myFunc);
            assert.strictEqual(wrapped.name, "myFunc");
        });

        it("should use provided name", () => {
            const wrapped = traced(() => 42, { name: "custom" });
            assert.strictEqual(wrapped.name, "custom");
        });

        it("should use 'anonymous' for unnamed functions", () => {
            // Arrow functions assigned to variables get their name from the variable,
            // so we need a truly anonymous function via indirect means
            const wrapped = traced((() => () => 42)());
            assert.strictEqual(wrapped.name, "anonymous");
        });

        it("should preserve function length", () => {
            function myFunc(a: number, b: number, c: number) {
                return a + b + c;
            }
            const wrapped = traced(myFunc);
            assert.strictEqual(wrapped.length, 3);
        });
    });

    describe("recordArgs", () => {
        it("should work with recordArgs=false (default)", () => {
            const fn = traced((x: number) => x * 2, { name: "double" });
            assert.strictEqual(fn(5), 10);
        });

        it("should work with recordArgs=true", () => {
            const fn = traced((x: number) => x * 2, { name: "double", recordArgs: true });
            assert.strictEqual(fn(5), 10);
        });

        it("should work with recordArgs whitelist", () => {
            const fn = traced((a: number, b: number) => a + b, {
                name: "add",
                recordArgs: ["0"], // only first arg
            });
            assert.strictEqual(fn(2, 3), 5);
        });
    });

    describe("argsFilter", () => {
        it("should apply argsFilter without affecting return value", () => {
            const fn = traced(
                (data: { password: string }) => data.password,
                {
                    name: "login",
                    recordArgs: true,
                    argsFilter: (args) =>
                        args.map((a) => (typeof a === "object" && a !== null ? { ...a, password: "***" } : a)),
                },
            );
            // argsFilter only affects what is recorded in the span, not the actual arguments
            assert.strictEqual(fn({ password: "secret" }), "secret");
        });
    });

    describe("this binding", () => {
        it("should preserve this context", () => {
            const obj = {
                value: 42,
                getVal: traced(function (this: { value: number }) {
                    return this.value;
                }, { name: "getVal" }),
            };
            assert.strictEqual(obj.getVal(), 42);
        });
    });

    describe("type preservation", () => {
        it("should return same type as original function", () => {
            const original = (x: number): string => String(x);
            const wrapped = traced(original, { name: "toString" });
            const result: string = wrapped(42);
            assert.strictEqual(result, "42");
        });

        it("should preserve async return type", async () => {
            const original = async (x: number): Promise<string> => String(x);
            const wrapped = traced(original, { name: "asyncToString" });
            const result: string = await wrapped(42);
            assert.strictEqual(result, "42");
        });
    });

    describe("custom attributes", () => {
        it("should accept custom attributes option", () => {
            const fn = traced((x: number) => x, {
                name: "withAttrs",
                attributes: { "custom.key": "value", "custom.num": 42 },
            });
            // Function still works correctly with custom attributes
            assert.strictEqual(fn(10), 10);
        });
    });
});
