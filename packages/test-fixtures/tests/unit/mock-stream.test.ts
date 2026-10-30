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

  // Without a delay no item waits for a timer: the whole stream is consumed
  // through promise callbacks alone, so a zero-delay timer scheduled before the
  // iteration cannot fire until the iteration is over. Any per-item timer, however
  // short, lets that rival fire first. The check needs no clock reading.
  for (const [label, options] of [
    ["no options", undefined],
    ["empty options", {}],
    ["delayMs: 0", { delayMs: 0 }],
    ["delayMs: undefined", { delayMs: undefined as never }],
  ] as const) {
    it(`without a delay no item waits for a timer: ${label}`, async () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      let rivalTimerFired = false;
      const rival = setTimeout(() => {
        rivalTimerFired = true;
      }, 0);

      const collected: number[] = [];
      for await (const item of createMockStream(items, options)) {
        collected.push(item);
      }
      const firedDuringIteration = rivalTimerFired;
      clearTimeout(rival);

      assert.deepStrictEqual(collected, items);
      assert.strictEqual(firedDuringIteration, false, "a timer fired while the stream was being consumed");
    });
  }

  // setTimeout turns a negative, NaN or too large delay into 1 ms (with a warning on Node.js),
  // so the stream would pace itself differently from what the test asked for.
  it("a delay that cannot be honoured throws at creation and names the option", () => {
    for (const delayMs of [-5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "10", null]) {
      assert.throws(
        () => createMockStream([1], { delayMs: delayMs as never }),
        (err: unknown) => (err instanceof RangeError || err instanceof TypeError) && err.message.includes("delayMs"),
        `delayMs ${String(delayMs)}`,
      );
    }
  });

  it("the largest delay setTimeout accepts is allowed", () => {
    assert.doesNotThrow(() => createMockStream([1], { delayMs: 2 ** 31 - 1 }));
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
});
