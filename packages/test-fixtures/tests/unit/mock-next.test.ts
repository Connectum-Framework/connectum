import assert from "node:assert";
import { before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { DescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
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

  // Editing a nested object of one response must not leak into the next one or into the supplied
  // message: a copy one level deep shares everything below the top level.
  it("every call gets its own copy at every depth", async () => {
    const supplied = { nested: { a: 1, list: [{ b: 2 }] }, when: new Date(0), tags: new Set(["x"]), bytes: new Uint8Array([1, 2]) };
    const next = createMockNext({ message: supplied });

    const first = (await next({})).message as typeof supplied;
    first.nested.a = 99;
    first.nested.list[0]!.b = 99;
    first.tags.add("y");
    first.bytes[0] = 99;
    first.when.setTime(5);
    const second = (await next({})).message as typeof supplied;

    assert.deepStrictEqual(second, { nested: { a: 1, list: [{ b: 2 }] }, when: new Date(0), tags: new Set(["x"]), bytes: new Uint8Array([1, 2]) });
    assert.strictEqual(supplied.nested.a, 1, "the supplied message stays untouched");
    assert.notStrictEqual(second.nested, supplied.nested);
  });

  // An object nested in the message that is not a plain object may keep state a copy cannot
  // reproduce (Headers, URL, a class with #private fields). It was handed out as it was before
  // the copy went deeper, and must keep working.
  it("a nested Headers, URL or class with private fields keeps working", async () => {
    class Counter {
      #count = 41;
      next() {
        return ++this.#count;
      }
    }
    const headers = new Headers({ a: "1" });
    const url = new URL("https://example.com/x");
    const counter = new Counter();
    const next = createMockNext({ message: { headers, url, counter } });

    const message = (await next({})).message as { headers: Headers; url: URL; counter: Counter };

    assert.strictEqual(message.headers.get("a"), "1");
    assert.strictEqual(message.url.href, "https://example.com/x");
    assert.strictEqual(message.counter.next(), 42);
  });

  // A message that is itself a class instance was copied into a plain object of its own
  // enumerable properties; it still is, and every call gets a separate object.
  it("a message that is a class instance becomes a plain copy of its own properties", async () => {
    class Money {
      amount: { units: number };
      constructor(amount: { units: number }) {
        this.amount = amount;
      }
    }
    const supplied = new Money({ units: 3 });
    const next = createMockNext({ message: supplied });

    const first = (await next({})).message as Money;
    const second = (await next({})).message as Money;

    assert.deepStrictEqual({ ...first }, { amount: { units: 3 } });
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.amount, supplied.amount);
    first.amount.units = 9;
    assert.strictEqual(second.amount.units, 3);
  });

  // One Uint8Array used as a field and as a Map key is one object in the supplied message;
  // the copy has to keep it one object, or the lookup by that key stops working.
  it("a byte array that appears twice in the message stays one object in the copy", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const shared = Buffer.from("k");
    const supplied = { key: bytes, values: new Map([[bytes, "ok"]]), buffer: shared, again: shared, date: new Date(0) };
    const next = createMockNext({ message: supplied });

    const copy = (await next({})).message as typeof supplied;

    assert.strictEqual(copy.values.get(copy.key), "ok");
    assert.notStrictEqual(copy.key, bytes);
    assert.strictEqual(copy.buffer, copy.again);
    assert.notStrictEqual(copy.buffer, shared);
  });

  // protobuf-es decodes every `bytes` field as a subarray of the wire buffer; the copy has to keep
  // the views on one (copied) buffer instead of duplicating the whole buffer for each field.
  it("views of one buffer keep sharing one buffer in the copy", async () => {
    const wire = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const supplied = { a: wire.subarray(0, 2), b: wire.subarray(2, 6), c: Buffer.from(wire.buffer, 4, 2), d: new DataView(wire.buffer, 1, 3) };
    const next = createMockNext({ message: supplied });

    const copy = (await next({})).message as typeof supplied;

    assert.deepStrictEqual([...copy.a], [1, 2]);
    assert.deepStrictEqual([...copy.b], [3, 4, 5, 6]);
    assert.deepStrictEqual([...copy.c], [5, 6]);
    assert.strictEqual(copy.d.getUint8(0), 2);
    assert.ok(Buffer.isBuffer(copy.c));
    assert.strictEqual(copy.a.buffer, copy.b.buffer);
    assert.strictEqual(copy.a.buffer, copy.c.buffer);
    assert.strictEqual(copy.a.buffer, copy.d.buffer);
    assert.notStrictEqual(copy.a.buffer, wire.buffer);
    copy.b[0] = 99;
    assert.strictEqual(wire[2], 3, "the supplied buffer stays untouched");
    assert.strictEqual(copy.a.byteOffset, 0);
    assert.strictEqual(copy.b.byteOffset, 2);
  });

  // The earlier shallow copy read each property once and stored the value as an ordinary editable
  // property; the deep copy does the same, so a getter or a setter never reaches the supplied object.
  it("a getter and a setter of the supplied message become plain editable properties", async () => {
    let writes = 0;
    const supplied = {
      get computed() {
        return { n: 1 };
      },
      get readonly() {
        return "r";
      },
      set sink(_value: number) {
        writes++;
      },
    };
    const next = createMockNext({ message: supplied });

    const copy = (await next({})).message as { computed: { n: number }; readonly: string };
    copy.readonly = "changed";
    copy.computed.n = 2;

    assert.strictEqual(copy.readonly, "changed");
    assert.strictEqual(copy.computed.n, 2);
    assert.strictEqual(supplied.computed.n, 1);
    assert.strictEqual(writes, 0);
    assert.deepStrictEqual(Object.keys(copy), ["computed", "readonly", "sink"]);
  });

  // A proto2 message with explicit field presence is made with Object.create(prototype), so it is
  // not a plain object; it is a message all the same and must be isolated like any other.
  it("a nested proto2 message with a prototype is copied, with its prototype", async () => {
    const nested = create(DescriptorProtoSchema, { name: "a" });
    assert.notStrictEqual(Object.getPrototypeOf(nested), Object.prototype, "reference: a proto2 message has a prototype of its own");
    const next = createMockNext({ message: { nested } });

    const first = (await next({})).message as { nested: typeof nested };
    first.nested.name = "changed";
    const second = (await next({})).message as { nested: typeof nested };

    assert.strictEqual(second.nested.name, "a");
    assert.strictEqual(nested.name, "a");
    assert.strictEqual(Object.getPrototypeOf(second.nested), Object.getPrototypeOf(nested));
    assert.strictEqual(second.nested.$typeName, "google.protobuf.DescriptorProto");
  });

  it("a RegExp keeps its lastIndex in the copy", async () => {
    const sticky = /x/y;
    sticky.lastIndex = 1;
    const next = createMockNext({ message: { sticky } });

    const copy = (await next({})).message as { sticky: RegExp };

    assert.strictEqual(copy.sticky.lastIndex, 1);
    assert.ok(copy.sticky.test("ax"));
    assert.strictEqual(sticky.lastIndex, 1, "the supplied RegExp is not advanced");
  });

  it("a message with a cycle and a shared reference is copied without looping", async () => {
    const shared = { n: 1 };
    const supplied: Record<string, unknown> = { a: shared, b: shared };
    supplied.self = supplied;
    const next = createMockNext({ message: supplied });

    const copy = (await next({})).message as typeof supplied;

    assert.strictEqual(copy.self, copy);
    assert.strictEqual(copy.a, copy.b);
    assert.notStrictEqual(copy.a, shared);
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
  // `new ConnectError(message, undefined)` quietly becomes Unknown and 999 is a code nobody can
  // name; a test built on either asserts on the wrong failure.
  it("a code that is not a Code throws and names the value", () => {
    for (const code of [undefined, null, 0, 17, 999, -1, 2.5, Number.NaN, "NotFound"]) {
      assert.throws(
        () => createMockNextError(code as never, "x"),
        (err: unknown) => err instanceof TypeError && err.message.includes("code") && err.message.includes(typeof code === "number" ? String(code) : (JSON.stringify(code) ?? String(code))),
        `code ${String(code)}`,
      );
    }
  });

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

  // setTimeout turns a negative, NaN or too large delay into 1 ms, so the "slow" handler would
  // answer at once while the test believes it is slow. Creation fails and names the argument.
  it("a delay that cannot be honoured throws at creation and names the argument", () => {
    for (const delay of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 31, "10", undefined, null]) {
      assert.throws(
        () => createMockNextSlow(delay as never),
        (err: unknown) => (err instanceof RangeError || err instanceof TypeError) && err.message.includes("delay"),
        `delay ${String(delay)}`,
      );
    }
  });

  it("zero and the largest delay setTimeout accepts are allowed", () => {
    assert.doesNotThrow(() => createMockNextSlow(0));
    assert.doesNotThrow(() => createMockNextSlow(2 ** 31 - 1));
  });

  it("every call gets its own copy at every depth", async () => {
    const supplied = { nested: { a: 1 } };
    const next = createMockNextSlow(1, { message: supplied });

    ((await next({})).message as typeof supplied).nested.a = 99;

    assert.strictEqual(((await next({})).message as typeof supplied).nested.a, 1);
    assert.strictEqual(supplied.nested.a, 1);
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
