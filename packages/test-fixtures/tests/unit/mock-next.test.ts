import assert from "node:assert";
import { before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createMockNext, createMockNextError, createMockNextSlow } from "../../src/mock-next.ts";
import { type ObservedCall, observeRealCalls, realService } from "./support/real-protobuf.ts";

// Expected values come from the responses and errors of a real transport
// (tests/unit/support/real-protobuf.ts) and from the Code enum of @connectrpc/connect.

interface Payload {
  id: number;
}

/**
 * Two responses of a real client to a handler that returns one and the same
 * object both times, plus that object.
 */
async function realResponsesToSharedHandlerResult(): Promise<{ shared: Payload; first: Payload; second: Payload }> {
  const svc = realService();
  const shared: Payload = { id: 7 };
  const transport = createRouterTransport(({ service }) => {
    // The descriptor is compiled at run time, so the handler map is not statically typed.
    service(svc, { getUser: () => shared } as never);
  });
  const client = createClient(svc, transport) as unknown as { getUser(input: unknown): Promise<Payload> };
  return { shared, first: await client.getUser({}), second: await client.getUser({}) };
}

const ALL_CODES = Object.values(Code).filter((value): value is Code => typeof value === "number");

describe("createMockNext", () => {
  let unary: ObservedCall;
  let serverStreaming: ObservedCall;

  before(async () => {
    ({ unary, serverStreaming } = await observeRealCalls());
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

  // A real client never hands out the object a handler returned: every call
  // yields a response of its own, so editing one response affects nobody else.
  it("every call gets its own response message, as with a real client", async () => {
    const real = await realResponsesToSharedHandlerResult();
    assert.notStrictEqual(real.first, real.second, "reference: responses are distinct objects");
    assert.notStrictEqual(real.first, real.shared, "reference: the handler result is not handed out");

    const supplied: Payload = { id: 7 };
    const next = createMockNext({ message: supplied });
    const first = (await next({})).message as Payload;
    const second = (await next({})).message as Payload;

    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first, supplied);
    first.id = 99;
    assert.strictEqual(second.id, 7, "editing one response must not change the next one");
    assert.strictEqual(supplied.id, 7, "editing a response must not change the supplied message");
  });

  it("stream flag follows the real response: unary by default, a stream when requested", async () => {
    assert.strictEqual(unary.res.stream, false, "reference: a unary response is not a stream");
    assert.strictEqual(serverStreaming.res.stream, true, "reference: a server-streaming response is a stream");

    assert.strictEqual((await createMockNext()({})).stream, unary.res.stream);
    assert.strictEqual((await createMockNext({ stream: false })({})).stream, unary.res.stream);
    assert.strictEqual((await createMockNext({ stream: true })({})).stream, serverStreaming.res.stream);
  });

  it("has spy capabilities via mock.calls", async () => {
    const next = createMockNext();
    const request = { payload: "test" };
    await next(request);

    assert.strictEqual(next.mock.calls.length, 1);
    assert.strictEqual(next.mock.calls[0].arguments[0], request, "the spy records the very request object handed to next()");
  });

  it("has spy capabilities via mock.callCount()", async () => {
    const next = createMockNext();
    await next({});
    await next({});

    assert.strictEqual(next.mock.callCount(), 2);
  });
});

describe("createMockNextError", () => {
  for (const code of ALL_CODES) {
    it(`rejects with a ConnectError that carries the code: ${Code[code]}`, async () => {
      const next = createMockNextError(code, "boom");

      await assert.rejects(
        () => next({}),
        (err: unknown) => {
          assert.ok(err instanceof ConnectError);
          assert.strictEqual(err.code, code);
          assert.strictEqual(err.rawMessage, "boom");
          assert.strictEqual(ConnectError.from(err).code, code);
          return true;
        },
      );
    });
  }

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
        assert.strictEqual(err.code, Code.Internal);
        assert.strictEqual(err.rawMessage, "Mock error");
        return true;
      },
    );
  });

  it("has spy capabilities", async () => {
    const next = createMockNextError(Code.Unimplemented);
    const first = { call: 1 };
    const second = { call: 2 };

    await assert.rejects(() => next(first), ConnectError);
    await assert.rejects(() => next(second), ConnectError);

    assert.strictEqual(next.mock.callCount(), 2);
    assert.deepStrictEqual(
      next.mock.calls.map((call: { arguments: unknown[] }) => call.arguments),
      [[first], [second]],
      "a call that ended in an error is still recorded with its argument",
    );
  });
});

describe("createMockNextSlow", () => {
  let unary: ObservedCall;
  let serverStreaming: ObservedCall;

  before(async () => {
    ({ unary, serverStreaming } = await observeRealCalls());
  });

  // The delay is observed from the outside: a rival timer much shorter than the
  // delay must win the race, and the response must still arrive afterwards.
  it("returns the default response only after the delay has elapsed", async () => {
    const pending = createMockNextSlow(100)({});

    const early = await Promise.race([pending, setTimeout(10, "still pending")]);

    assert.strictEqual(early, "still pending");
    assert.deepStrictEqual(await pending, { message: { result: "success" }, stream: false });
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

  it(
    "every call gets its own response message, as with a real client",
    async () => {
      const supplied: Payload = { id: 7 };
      const next = createMockNextSlow(1, { message: supplied });

      const first = (await next({})).message as Payload;
      const second = (await next({})).message as Payload;

      assert.notStrictEqual(first, second);
      assert.notStrictEqual(first, supplied);
    },
  );

  it("stream flag follows the real response: unary by default, a stream when requested", async () => {
    assert.strictEqual((await createMockNextSlow(1)({})).stream, unary.res.stream);
    assert.strictEqual((await createMockNextSlow(1, { stream: false })({})).stream, unary.res.stream);
    assert.strictEqual((await createMockNextSlow(1, { stream: true })({})).stream, serverStreaming.res.stream);
  });

  it("has spy capabilities", async () => {
    const next = createMockNextSlow(10);
    await next({});

    assert.strictEqual(next.mock.callCount(), 1);
    assert.strictEqual(next.mock.calls.length, 1);
  });
});
