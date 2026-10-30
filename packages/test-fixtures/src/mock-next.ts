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
import { type Code, ConnectError } from "@connectrpc/connect";
import { createMockFn } from "./mock-compat.ts";
import type { MockNextOptions } from "./types.ts";
import { assertTimerDelay } from "./validate.ts";

/**
 * Copy a response message at every depth, so that editing one response reaches neither
 * the next response nor the message the test supplied.
 *
 * Plain objects, class instances (the prototype is kept), arrays, `Map`, `Set`, `Date`,
 * `RegExp`, `Buffer` and typed arrays are copied; shared references and cycles are
 * preserved. Functions and objects with internal state that cannot be copied (promises,
 * `WeakMap`, `WeakSet`, `WeakRef`) are kept as they are. Own properties are copied;
 * `#private` fields of a class instance are not.
 *
 * @internal
 */
function cloneMessage(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const known = seen.get(value);
    if (known !== undefined) {
        return known;
    }
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet || value instanceof WeakRef) {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return structuredClone(value);
    }
    if (value instanceof Date) {
        return new Date(value.getTime());
    }
    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags);
    }
    if (value instanceof Map) {
        const copy = new Map();
        seen.set(value, copy);
        for (const [key, entry] of value) {
            copy.set(cloneMessage(key, seen), cloneMessage(entry, seen));
        }
        return copy;
    }
    if (value instanceof Set) {
        const copy = new Set();
        seen.set(value, copy);
        for (const entry of value) {
            copy.add(cloneMessage(entry, seen));
        }
        return copy;
    }
    const copy: object = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || (Array.isArray(value) && key === "length")) {
            continue;
        }
        if ("value" in descriptor) {
            descriptor.value = cloneMessage(descriptor.value, seen);
            // A frozen supplied message still yields responses a test can edit, as the shallow copy did.
            descriptor.writable = true;
            descriptor.configurable = true;
        }
        Object.defineProperty(copy, key, descriptor);
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
