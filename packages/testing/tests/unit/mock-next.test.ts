import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockNext, createMockNextError, createMockNextSlow } from "../../src/mock-next.ts";

describe("createMockNext", () => {
  it("returns a function", () => {
    const next = createMockNext();

    assert.strictEqual(typeof next, "function");
  });

  it("resolves with default response", async () => {
    const next = createMockNext();
    const res = await next({});

    assert.deepStrictEqual(res, { message: { result: "success" }, stream: false });
  });

  it("custom message option works", async () => {
    const next = createMockNext({ message: { id: 42, name: "Alice" } });
    const res = await next({});

    assert.deepStrictEqual(res.message, { id: 42, name: "Alice" });
  });

  it("custom stream option works", async () => {
    const next = createMockNext({ stream: true });
    const res = await next({});

    assert.strictEqual(res.stream, true);
  });

  it("has spy capabilities via mock.calls", async () => {
    const next = createMockNext();
    await next({ payload: "test" });

    assert.strictEqual(next.mock.calls.length, 1);
  });

  it("has spy capabilities via mock.callCount()", async () => {
    const next = createMockNext();
    await next({});
    await next({});

    assert.strictEqual(next.mock.callCount(), 2);
  });
});

describe("createMockNextError", () => {
  it("throws ConnectError with correct code", async () => {
    const next = createMockNextError(Code.NotFound);

    await assert.rejects(
      () => next({}),
      (err: any) => {
        assert.ok(err instanceof ConnectError);
        assert.strictEqual(err.code, Code.NotFound);
        return true;
      },
    );
  });

  it("throws ConnectError with correct message", async () => {
    const next = createMockNextError(Code.PermissionDenied, "access denied");

    await assert.rejects(
      () => next({}),
      (err: any) => {
        assert.ok(err instanceof ConnectError);
        assert.strictEqual(err.message, "[permission_denied] access denied");
        return true;
      },
    );
  });

  it("default message is 'Mock error'", async () => {
    const next = createMockNextError(Code.Internal);

    await assert.rejects(
      () => next({}),
      (err: any) => {
        assert.ok(err instanceof ConnectError);
        assert.ok(err.message.includes("Mock error"));
        return true;
      },
    );
  });

  it("has spy capabilities", async () => {
    const next = createMockNextError(Code.Unimplemented);

    await next({}).catch(() => {});
    await next({}).catch(() => {});

    assert.strictEqual(next.mock.callCount(), 2);
  });
});

describe("createMockNextSlow", () => {
  it("returns response after delay", async () => {
    const next = createMockNextSlow(50);
    const res = await next({});

    assert.deepStrictEqual(res, { message: { result: "success" }, stream: false });
  });

  it("takes at least delay ms", async () => {
    const delay = 100;
    const next = createMockNextSlow(delay);

    const start = Date.now();
    await next({});
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= delay - 5, `Expected at least ${delay}ms, got ${elapsed}ms`);
  });

  it("custom message works", async () => {
    const next = createMockNextSlow(10, { message: { status: "delayed" } });
    const res = await next({});

    assert.deepStrictEqual(res.message, { status: "delayed" });
  });

  it("has spy capabilities", async () => {
    const next = createMockNextSlow(10);
    await next({});

    assert.strictEqual(next.mock.callCount(), 1);
    assert.strictEqual(next.mock.calls.length, 1);
  });
});
