process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { shutdownProvider } from "../../src/provider.ts";
import { traced } from "../../src/traced.ts";
import { observe, onlySpan } from "./observe.ts";

/** Runs a body and returns the one span it produced. */
async function spanOf(body: () => unknown): Promise<ReturnType<typeof onlySpan>> {
    return onlySpan(
        await observe(async () => {
            await body();
        }),
    );
}

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
        it("should use function name as default span name", async () => {
            function myFunc() {
                return 42;
            }
            const wrapped = traced(myFunc);

            const span = await spanOf(() => wrapped());

            assert.strictEqual(span.name, "myFunc");
            assert.strictEqual(wrapped.name, "myFunc");
        });

        it("should use provided name", async () => {
            const wrapped = traced(() => 42, { name: "custom" });

            const span = await spanOf(() => wrapped());

            assert.strictEqual(span.name, "custom");
            assert.strictEqual(wrapped.name, "custom");
        });

        it("should use 'anonymous' for unnamed functions", async () => {
            // Arrow functions assigned to variables get their name from the variable,
            // so we need a truly anonymous function via indirect means
            const wrapped = traced((() => () => 42)());

            const span = await spanOf(() => wrapped());

            assert.strictEqual(span.name, "anonymous");
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
        // The tracing guide: `recordArgs: true` serializes the argument values into the
        // `function.args` span attribute, and an array selects zero-based argument positions.
        it("records no function.args by default", async () => {
            const fn = traced((x: number) => x * 2, { name: "double" });
            let result: number | undefined;

            const span = await spanOf(() => {
                result = fn(5);
            });

            assert.strictEqual(result, 10);
            assert.ok(!("function.args" in span.attributes), "arguments may hold credentials and are not recorded unless asked for");
        });

        it("records the serialized arguments in function.args with recordArgs=true", async () => {
            const fn = traced((x: number, label: string) => `${label}${x * 2}`, { name: "double", recordArgs: true });
            let result: string | undefined;

            const span = await spanOf(() => {
                result = fn(5, "n=");
            });

            assert.strictEqual(result, "n=10");
            assert.strictEqual(span.attributes["function.args"], '[5,"n="]');
        });

        const whitelists: Array<[string[], string]> = [
            [["0"], "[2]"],
            [["1"], "[3]"],
            [["0", "1"], "[2,3]"],
            [["2"], "[]"],
        ];
        for (const [positions, recorded] of whitelists) {
            it(`records only the arguments at positions ${JSON.stringify(positions)}`, async () => {
                const fn = traced((a: number, b: number) => a + b, { name: "add", recordArgs: positions });
                let result: number | undefined;

                const span = await spanOf(() => {
                    result = fn(2, 3);
                });

                assert.strictEqual(result, 5);
                assert.strictEqual(span.attributes["function.args"], recorded);
            });
        }
    });

    describe("argsFilter", () => {
        it("masks the recorded arguments without changing what the function receives", async () => {
            const fn = traced((data: { password: string }) => data.password, {
                name: "login",
                recordArgs: true,
                argsFilter: (args) => args.map((a) => (typeof a === "object" && a !== null ? { ...a, password: "***" } : a)),
            });
            let result: string | undefined;

            const span = await spanOf(() => {
                result = fn({ password: "secret" });
            });

            assert.strictEqual(result, "secret", "argsFilter only affects what is recorded, not the actual arguments");
            assert.strictEqual(span.attributes["function.args"], '[{"password":"***"}]');
            assert.ok(!JSON.stringify(span).includes("secret"), "the secret does not appear anywhere in the exported span");
        });

        it("applies the position whitelist before argsFilter sees the arguments", async () => {
            const seen: unknown[][] = [];
            const fn = traced((_a: string, _b: string) => "done", {
                name: "pair",
                recordArgs: ["1"],
                argsFilter: (args) => {
                    seen.push([...args]);
                    return args;
                },
            });

            const span = await spanOf(() => fn("first", "second"));

            assert.deepStrictEqual(seen, [["second"]]);
            assert.strictEqual(span.attributes["function.args"], '["second"]');
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
        it("should return same type as original function", async () => {
            const original = (x: number): string => String(x);
            const wrapped = traced(original, { name: "toString" });
            let result: string | undefined;

            const span = await spanOf(() => {
                result = wrapped(42);
            });

            assert.strictEqual(result, "42");
            assert.strictEqual(span.name, "toString");
        });

        it("should preserve async return type and end the span once the promise settles", async () => {
            const original = async (x: number): Promise<string> => String(x);
            const wrapped = traced(original, { name: "asyncToString" });
            let result: string | undefined;

            // A span that was never ended is not exported, so finding it proves it was ended.
            const span = await spanOf(async () => {
                const pending: Promise<string> = wrapped(42);
                result = await pending;
            });

            assert.strictEqual(result, "42");
            assert.strictEqual(span.name, "asyncToString");
        });
    });

    describe("custom attributes", () => {
        it("sets the given attributes on the span, and only those", async () => {
            const fn = traced((x: number) => x, {
                name: "withAttrs",
                attributes: { "custom.key": "value", "custom.num": 42, "custom.flag": true },
            });
            let result: number | undefined;

            const span = await spanOf(() => {
                result = fn(10);
            });

            assert.strictEqual(result, 10);
            assert.deepStrictEqual(span.attributes, { "custom.flag": true, "custom.key": "value", "custom.num": 42 });
        });
    });
});
