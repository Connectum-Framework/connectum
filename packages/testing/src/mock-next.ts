/**
 * Factories for mock ConnectRPC `next` handler functions.
 *
 * These helpers produce spy-enabled mock functions (via `node:test` `mock.fn`)
 * that simulate the downstream handler in an interceptor chain, allowing tests
 * to verify that interceptors correctly invoke (or skip) the next handler.
 *
 * @module
 */

import { mock } from "node:test";
import { setTimeout } from "node:timers/promises";
import { type Code, ConnectError } from "@connectrpc/connect";
import type { MockNextOptions } from "./types.ts";

/**
 * Create a mock `next` handler that resolves with a successful response.
 *
 * The returned function is a `mock.fn()` spy, so callers can inspect
 * `next.mock.calls` and `next.mock.callCount()` after the test.
 *
 * @param options - Optional overrides for the response payload and stream flag.
 * @returns A spy-enabled async function matching the ConnectRPC `next` signature.
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

    return mock.fn(async (_req: unknown) => ({
        stream,
        message: { ...baseMessage },
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
    return mock.fn(async (_req: unknown) => {
        throw new ConnectError(message ?? "Mock error", code);
    });
}

/**
 * Create a mock `next` handler that resolves after a configurable delay.
 *
 * Useful for testing timeout interceptors and other time-sensitive logic.
 *
 * @param delay   - Time to wait in milliseconds before resolving.
 * @param options - Optional overrides for the response payload and stream flag.
 * @returns A spy-enabled async function that sleeps before returning a response.
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
    return mock.fn(async (_req: unknown) => {
        await setTimeout(delay);
        return {
            stream: options?.stream ?? false,
            message: options?.message ?? { result: "success" },
        };
    });
}
