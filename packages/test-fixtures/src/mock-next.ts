/**
 * Factories for mock ConnectRPC `next` handler functions.
 *
 * These helpers produce spy-enabled mock functions (via {@link createMockFn})
 * that simulate the downstream handler in an interceptor chain, allowing tests
 * to verify that interceptors correctly invoke (or skip) the next handler.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockFn } from "./mock-compat.ts";
import type { MockNextOptions } from "./types.ts";
import { assertTimerDelay } from "./validate.ts";

/**
 * Copy a response message at every depth, so that editing one response reaches neither
 * the next response nor the message the test supplied.
 *
 * Plain objects (the shape of every protobuf-es message), arrays, `Map`, `Set`, `Date`,
 * `RegExp`, `Buffer`, typed arrays and `ArrayBuffer` are copied; shared references and
 * cycles are preserved. Any other object nested in the message (a `Headers`, a `URL`, a
 * class instance, a promise) is kept by reference, because it may hold internal state a
 * copy cannot reproduce, and so is a function. A message that is itself such an object is
 * copied into a plain object of its own enumerable properties, as the earlier shallow
 * copy did.
 *
 * @internal
 */
function cloneMessage(value: unknown, seen: Map<object, unknown> = new Map(), top = true): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const known = seen.get(value);
    if (known !== undefined) {
        return known;
    }
    if (value instanceof ArrayBuffer) {
        const copy = value.slice(0);
        seen.set(value, copy);
        return copy;
    }
    if (ArrayBuffer.isView(value)) {
        // The views of one backing buffer (a protobuf `bytes` field is a `subarray` of the
        // wire buffer) have to keep sharing one buffer in the copy, and the buffer is
        // copied once. A view over a SharedArrayBuffer cannot be copied and is kept.
        if (!(value.buffer instanceof ArrayBuffer)) {
            return value;
        }
        const buffer = cloneMessage(value.buffer, seen, false) as ArrayBuffer;
        const copy = Buffer.isBuffer(value)
            ? Buffer.from(buffer, value.byteOffset, value.byteLength)
            : value instanceof DataView
              ? new DataView(buffer, value.byteOffset, value.byteLength)
              : new (value.constructor as new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView)(
                    buffer,
                    value.byteOffset,
                    (value as unknown as { length: number }).length,
                );
        seen.set(value, copy);
        return copy;
    }
    if (value instanceof Date) {
        const copy = new Date(value.getTime());
        seen.set(value, copy);
        return copy;
    }
    if (value instanceof RegExp) {
        const copy = new RegExp(value.source, value.flags);
        seen.set(value, copy);
        return copy;
    }
    if (value instanceof Map) {
        const copy = new Map();
        seen.set(value, copy);
        for (const [key, entry] of value) {
            copy.set(cloneMessage(key, seen, false), cloneMessage(entry, seen, false));
        }
        return copy;
    }
    if (value instanceof Set) {
        const copy = new Set();
        seen.set(value, copy);
        for (const entry of value) {
            copy.add(cloneMessage(entry, seen, false));
        }
        return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    const isPlain = prototype === Object.prototype || prototype === null;
    if (!isArray && !isPlain) {
        if (!top) {
            return value;
        }
        const copy: Record<string, unknown> = {};
        seen.set(value, copy);
        for (const key of Object.keys(value)) {
            copy[key] = cloneMessage((value as Record<string, unknown>)[key], seen, false);
        }
        return copy;
    }
    const copy: object = isArray ? new Array(value.length) : Object.create(prototype);
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
        // Own enumerable properties only, read through the property (a getter is called and
        // its value copied), and written as plain editable data properties: the same result
        // the earlier shallow copy gave, so a frozen message or an accessor yields responses
        // a test can edit without touching the supplied object.
        if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) {
            continue;
        }
        const entry = cloneMessage((value as Record<PropertyKey, unknown>)[key], seen, false);
        Object.defineProperty(copy, key, { value: entry, writable: true, enumerable: true, configurable: true });
    }
    return copy;
}

/**
 * Create a mock `next` handler that resolves with a successful response.
 *
 * The returned function is a spy (via {@link createMockFn}), so callers can
 * inspect `next.mock.calls` and `next.mock.callCount()` after the test.
 *
 * @param options - Optional overrides for the response payload and stream flag.
 *   Every call resolves with its own deep copy of `message`, so editing one response
 *   changes neither the next one nor the supplied object.
 * @returns a spy-enabled async function resolving to a partial response with
 *   `stream` and `message` fields. Use a real `next` response when the code
 *   under test reads response headers, trailers, or descriptors.
 *
 * @example
 * ```ts
 * import { createMockNext } from "@connectum/testing";
 *
 * const next = createMockNext({ message: { id: 1 } });
 * const res = await next({});
 * // res.message => { id: 1 }
 * // next.mock.callCount() => 1
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: ConnectRPC next() signature varies by context
export function createMockNext(options?: MockNextOptions): any {
    const stream = options?.stream ?? false;
    const baseMessage = options?.message ?? { result: "success" };

    return createMockFn(async (_req: unknown) => ({
        stream,
        message: cloneMessage(baseMessage),
    }));
}

/**
 * Create a mock `next` handler that always throws a {@link ConnectError}.
 *
 * Useful for testing how interceptors handle downstream failures.
 *
 * @param code    - The gRPC status code for the error.
 * @param message - Human-readable error message. Defaults to `"Mock error"`.
 * @returns A spy-enabled async function that throws on every call.
 * @throws TypeError when `code` is not a `Code` of `@connectrpc/connect` (an integer from 1 to 16).
 *
 * @example
 * ```ts
 * import { Code } from "@connectrpc/connect";
 * import { createMockNextError } from "@connectum/testing";
 *
 * const next = createMockNextError(Code.NotFound, "user not found");
 * await next({}).catch((err) => {
 *   // err instanceof ConnectError => true
 *   // err.code => Code.NotFound
 * });
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: ConnectRPC next() signature varies by context
export function createMockNextError(code: Code, message?: string): any {
    // `new ConnectError(message, undefined)` quietly becomes Unknown and an arbitrary number
    // is kept as a code no client can name, so the test would assert on the wrong failure.
    if (typeof code !== "number" || !Number.isInteger(code) || Code[code] === undefined) {
        throw new TypeError(
            `createMockNextError: code must be a Code from @connectrpc/connect (1 to 16), got ${typeof code === "number" ? code : (JSON.stringify(code) ?? String(code))}`,
        );
    }
    return createMockFn(async (_req: unknown) => {
        throw new ConnectError(message ?? "Mock error", code);
    });
}

/**
 * Create a mock `next` handler that resolves after a configurable delay.
 *
 * Useful for testing timeout interceptors and other time-sensitive logic.
 *
 * @param delay   - Time to wait in milliseconds before resolving: a finite number from 0 to 2147483647.
 * @param options - Optional overrides for the response payload and stream flag.
 * @returns A spy-enabled async function that sleeps before returning a response.
 * @throws TypeError when `delay` is not a number.
 * @throws RangeError when `delay` is negative, `NaN`, infinite or larger than 2147483647:
 *   the timer would turn it into 1 ms and the handler would not be slow.
 *
 * @example
 * ```ts
 * import { createMockNextSlow } from "@connectum/testing";
 *
 * const next = createMockNextSlow(500);
 * const res = await next({}); // resolves after ~500 ms
 * // res.message => { result: "success" }
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: ConnectRPC next() signature varies by context
export function createMockNextSlow(delay: number, options?: MockNextOptions): any {
    assertTimerDelay(delay, "createMockNextSlow: delay");
    const baseMessage = options?.message ?? { result: "success" };

    return createMockFn(async (_req: unknown) => {
        await setTimeout(delay);
        return {
            stream: options?.stream ?? false,
            message: cloneMessage(baseMessage),
        };
    });
}
