/**
 * Factory for mock async iterable streams.
 *
 * @module
 */

import { setTimeout } from "node:timers/promises";
import type { MockStreamOptions } from "./types.ts";

/**
 * Create an {@link AsyncIterable} that yields `items` sequentially.
 *
 * Useful for testing ConnectRPC server-streaming or client-streaming
 * interceptors and handlers without a real gRPC connection.
 *
 * The returned iterable is **reusable** — each call to
 * `Symbol.asyncIterator` starts a fresh iteration over the same items.
 *
 * @typeParam T - Type of items yielded by the stream.
 * @param items - Array of items to yield in order.
 * @param options - Optional stream behavior configuration.
 * @returns An async iterable that yields each item from `items`.
 *
 * @example
 * ```ts
 * import { createMockStream } from "@connectum/testing";
 *
 * const stream = createMockStream([1, 2, 3], { delayMs: 10 });
 *
 * for await (const value of stream) {
 *   console.log(value); // 1, 2, 3
 * }
 * ```
 */
export function createMockStream<T>(items: T[], options?: MockStreamOptions): AsyncIterable<T> {
    const delayMs = options?.delayMs;

    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) {
                if (delayMs !== undefined && delayMs > 0) {
                    await setTimeout(delayMs);
                }
                yield item;
            }
        },
    };
}
