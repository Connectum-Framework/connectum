import assert from "node:assert";
import { describe, it, mock } from "node:test";
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

  // node:test's mock.fn() is the API this spy mirrors: it records a call whose
  // implementation threw, and the error still reaches the caller.
  it("records a call whose implementation throws, like node:test mock.fn()", () => {
    const failure = new Error("boom");
    const reference = mock.fn((_x: number) => {
      throw failure;
    });
    assert.throws(() => reference(1), failure);
    assert.strictEqual(reference.mock.callCount(), 1, "reference: node:test records the throwing call");

    const fn = createMockFn((_x: number) => {
      throw failure;
    });

    assert.throws(() => fn(1), failure);
    assert.strictEqual(fn.mock.callCount(), reference.mock.callCount());
    assert.deepStrictEqual(fn.mock.calls[0]?.arguments, [1]);
  });

  // The same implementation wrapped by node:test and by createMockFn must behave the same for
  // the parts of the API documented as compatible: the `this` of the call, the recorded result
  // and error, and the snapshot semantics of `calls`.
  it("forwards `this` to the implementation, like node:test mock.fn()", () => {
    const impl = function (this: { v: number } | undefined) {
      return this?.v;
    };
    const reference = mock.fn(impl);
    const mine = createMockFn(impl);

    const referenceOwner = { v: 7, m: reference };
    const owner = { v: 7, m: mine };

    assert.strictEqual(referenceOwner.m(), 7, "reference: node:test forwards this");
    assert.strictEqual(owner.m(), 7);
    assert.strictEqual(mine.mock.calls[0]?.this, owner);
  });

  it("records the result of a call, like node:test mock.fn()", () => {
    const reference = mock.fn((a: number, b: number) => a + b);
    const mine = createMockFn((a: number, b: number) => a + b);
    reference(1, 2);
    mine(1, 2);

    assert.strictEqual(reference.mock.calls[0]?.result, 3, "reference");
    assert.strictEqual(mine.mock.calls[0]?.result, 3);
    assert.strictEqual(mine.mock.calls[0]?.error, undefined);
  });

  it("records the error a throwing implementation raised and rethrows it", () => {
    const failure = new Error("boom");
    const reference = mock.fn(() => {
      throw failure;
    });
    assert.throws(() => reference(), failure);
    assert.strictEqual(reference.mock.calls[0]?.error, failure, "reference");

    const mine = createMockFn(() => {
      throw failure;
    });

    assert.throws(() => mine(), failure);
    assert.strictEqual(mine.mock.calls[0]?.error, failure);
    assert.strictEqual(mine.mock.calls[0]?.result, undefined);
  });

  it("records the promise of an async implementation as its result and no error when it rejects", async () => {
    const failure = new Error("late");
    const reference = mock.fn(async () => {
      throw failure;
    });
    const mine = createMockFn(async () => {
      throw failure;
    });
    await assert.rejects(reference(), failure);
    await assert.rejects(mine(), failure);

    assert.ok(reference.mock.calls[0]?.result instanceof Promise, "reference");
    assert.ok(mine.mock.calls[0]?.result instanceof Promise);
    assert.strictEqual(mine.mock.calls[0]?.error, undefined);
  });

  // node:test on Node.js returns a copy; the Bun engine of the test runner hands out the live
  // list, so the reference is not consulted here and the copy is the contract of the fixture.
  it("a snapshot of calls does not grow with later calls", () => {
    const mine = createMockFn(() => 1);
    const snapshot = mine.mock.calls;
    mine();

    assert.strictEqual(snapshot.length, 0);
    assert.strictEqual(mine.mock.calls.length, 1);
  });

  it("clearing a copy of calls does not reset callCount()", () => {
    const mine = createMockFn(() => 1);
    mine();
    (mine.mock.calls as unknown[]).length = 0;

    assert.strictEqual(mine.mock.callCount(), 1);
    assert.strictEqual(mine.mock.calls.length, 1);
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
