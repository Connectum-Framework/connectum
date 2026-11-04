/**
 * Callbacks that compile as `onError`, and the ones that run.
 *
 * The type of `onError` returns `void`, so a function with any result is still accepted, the way
 * TypeScript allows for a `void` callback: an arrow that returns what `Array.prototype.push`
 * returns, or an `async` function that resolves to a value. Typing the result as
 * `void | Promise<void>` would reject both at compile time. This file is checked by `tsc`
 * (`pnpm typecheck`); a change to the type that rejects one of these fails there.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/test-fixtures";
import { createErrorHandlerInterceptor } from "../../src/errorHandler.ts";
import type { ErrorHandlerOptions } from "../../src/types.ts";

type Info = Parameters<NonNullable<ErrorHandlerOptions["onError"]>>[0];

describe("onError callbacks of any result type", () => {
    it("accepts a callback that returns a number, as `errors.push(info)` does", async () => {
        const errors: Info[] = [];
        const interceptor = createErrorHandlerInterceptor({ logErrors: false, onError: (info) => errors.push(info) });

        await assert.rejects(() => interceptor((async () => Promise.reject(new ConnectError("x", Code.NotFound))) as never)(createMockRequest()));

        assert.strictEqual(errors.length, 1);
    });

    it("accepts an async callback that resolves to a value and one that rejects with a value", async () => {
        const seen: number[] = [];
        const resolving = createErrorHandlerInterceptor({
            logErrors: false,
            onError: async () => {
                seen.push(1);
                return 42;
            },
        });
        const rejecting = createErrorHandlerInterceptor({
            logErrors: false,
            onError: async () => {
                seen.push(2);
                throw new Error("sink down");
            },
        });
        const fail = (async () => Promise.reject(new ConnectError("x", Code.NotFound))) as never;

        await assert.rejects(() => resolving(fail)(createMockRequest()));
        await assert.rejects(() => rejecting(fail)(createMockRequest()));

        assert.deepStrictEqual(seen, [1, 2]);
    });
});
