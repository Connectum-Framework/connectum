import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockFn } from "../../src/mock-compat.ts";

describe("createMockFn", () => {
  it("tracks calls correctly", () => {
    const fn = createMockFn((x: number) => x * 2);
    fn(5);

    assert.strictEqual(fn.mock.calls.length, 1);

    const call = fn.mock.calls[0];
    assert.ok(call, "expected at least one recorded call");
    assert.deepStrictEqual(call.arguments, [5]);
  });

  it("callCount returns correct number", () => {
    const fn = createMockFn(() => "ok");

    assert.strictEqual(fn.mock.callCount(), 0);

    fn();
    assert.strictEqual(fn.mock.callCount(), 1);

    fn();
    fn();
    assert.strictEqual(fn.mock.callCount(), 3);
  });

  it("preserves return value", () => {
    const fn = createMockFn((a: number, b: number) => a + b);
    const result = fn(3, 4);

    assert.strictEqual(result, 7);
  });

  it("preserves async return value", async () => {
    const fn = createMockFn(async (name: string) => `hello ${name}`);
    const result = await fn("world");

    assert.strictEqual(result, "hello world");
  });

  it("arguments are captured correctly", () => {
    const fn = createMockFn((a: string, b: number, c: boolean) => `${a}-${b}-${c}`);
    fn("foo", 42, true);

    const call = fn.mock.calls[0];
    assert.ok(call, "expected at least one recorded call");
    assert.deepStrictEqual(call.arguments, ["foo", 42, true]);
  });

  it("works with multiple calls", () => {
    const fn = createMockFn((x: number) => x);
    fn(1);
    fn(2);
    fn(3);

    assert.strictEqual(fn.mock.callCount(), 3);
    assert.strictEqual(fn.mock.calls.length, 3);

    const call0 = fn.mock.calls[0];
    const call1 = fn.mock.calls[1];
    const call2 = fn.mock.calls[2];
    assert.ok(call0 && call1 && call2, "expected three recorded calls");
    assert.deepStrictEqual(call0.arguments, [1]);
    assert.deepStrictEqual(call1.arguments, [2]);
    assert.deepStrictEqual(call2.arguments, [3]);
  });
});
