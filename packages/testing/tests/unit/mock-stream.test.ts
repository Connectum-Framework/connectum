import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockStream } from "../../src/mock-stream.ts";

describe("createMockStream", () => {
  it("yields all items in order", async () => {
    const items = [1, 2, 3, 4, 5];
    const stream = createMockStream(items);

    const collected: number[] = [];
    for await (const item of stream) {
      collected.push(item);
    }

    assert.deepStrictEqual(collected, [1, 2, 3, 4, 5]);
  });

  it("works with empty array", async () => {
    const stream = createMockStream([]);

    const collected: unknown[] = [];
    for await (const item of stream) {
      collected.push(item);
    }

    assert.deepStrictEqual(collected, []);
  });

  it("works with single item", async () => {
    const stream = createMockStream(["only"]);

    const collected: string[] = [];
    for await (const item of stream) {
      collected.push(item);
    }

    assert.deepStrictEqual(collected, ["only"]);
  });

  it("items are the exact same references (not cloned)", async () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const stream = createMockStream([obj1, obj2]);

    const collected: Array<{ id: number }> = [];
    for await (const item of stream) {
      collected.push(item);
    }

    assert.strictEqual(collected[0], obj1, "first item must be same reference");
    assert.strictEqual(collected[1], obj2, "second item must be same reference");
  });

  it("with delayMs, takes at least items.length * delayMs ms total", async () => {
    const delayMs = 20;
    const items = [1, 2, 3, 4, 5];
    const stream = createMockStream(items, { delayMs });

    const start = Date.now();
    for await (const _ of stream) {
      // consume
    }
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed >= items.length * delayMs,
      `expected at least ${items.length * delayMs}ms, got ${elapsed}ms`,
    );
  });

  it("without delay, completes fast", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const stream = createMockStream(items);

    const start = Date.now();
    for await (const _ of stream) {
      // consume
    }
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 200,
      `expected fast completion (<200ms), got ${elapsed}ms`,
    );
  });

  it("works with different types (string, number, object)", async () => {
    const strings = createMockStream(["a", "b", "c"]);
    const numbers = createMockStream([10, 20, 30]);
    const objects = createMockStream([{ x: 1 }, { x: 2 }]);

    const collectedStrings: string[] = [];
    for await (const s of strings) collectedStrings.push(s);
    assert.deepStrictEqual(collectedStrings, ["a", "b", "c"]);

    const collectedNumbers: number[] = [];
    for await (const n of numbers) collectedNumbers.push(n);
    assert.deepStrictEqual(collectedNumbers, [10, 20, 30]);

    const collectedObjects: Array<{ x: number }> = [];
    for await (const o of objects) collectedObjects.push(o);
    assert.deepStrictEqual(collectedObjects, [{ x: 1 }, { x: 2 }]);
  });

  it("is reusable — can iterate twice and get same items", async () => {
    const items = ["alpha", "beta", "gamma"];
    const stream = createMockStream(items);

    const first: string[] = [];
    for await (const item of stream) first.push(item);

    const second: string[] = [];
    for await (const item of stream) second.push(item);

    assert.deepStrictEqual(first, items);
    assert.deepStrictEqual(second, items);
    assert.deepStrictEqual(first, second);
  });

  it("implements AsyncIterable protocol (Symbol.asyncIterator)", () => {
    const stream = createMockStream([1, 2, 3]);

    assert.strictEqual(
      typeof stream[Symbol.asyncIterator],
      "function",
      "must have Symbol.asyncIterator method",
    );

    const iterator = stream[Symbol.asyncIterator]();
    assert.strictEqual(
      typeof iterator.next,
      "function",
      "iterator must have next() method",
    );
  });
});
