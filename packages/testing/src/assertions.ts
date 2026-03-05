/**
 * ConnectRPC error assertion helpers for testing.
 *
 * @module
 */

import assert from "node:assert";
import type { Code } from "@connectrpc/connect";
import { ConnectError } from "@connectrpc/connect";

/**
 * Assert that a thrown value is a {@link ConnectError} with the expected
 * gRPC status code and, optionally, a message matching a pattern.
 *
 * This is a TypeScript
 * {@link https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates | assertion function}:
 * after a successful call the compiler narrows `error` to `ConnectError`.
 *
 * **Note on message format**: ConnectError messages include a code prefix,
 * e.g. `[not_found] user not found`. The `messagePattern` is matched against
 * the full message string. Use a `RegExp` for flexible matching.
 *
 * @param error - The value to check (typically from a `catch` block).
 * @param expectedCode - Expected gRPC/Connect status code.
 * @param messagePattern - Optional substring or RegExp to match against
 *   `error.message`.
 *
 * @throws {AssertionError} When any of the checks fail.
 *
 * @example
 * ```ts
 * import { Code, ConnectError } from "@connectrpc/connect";
 * import { assertConnectError } from "@connectum/testing";
 *
 * try {
 *   await client.getUser({ id: "missing" });
 * } catch (err) {
 *   assertConnectError(err, Code.NotFound, "user not found");
 *   // err is now typed as ConnectError
 *   console.log(err.code); // Code.NotFound
 * }
 * ```
 */
export function assertConnectError(error: unknown, expectedCode: Code, messagePattern?: string | RegExp): asserts error is ConnectError {
    assert.ok(error instanceof ConnectError, `Expected ConnectError but got ${typeof error === "object" && error !== null ? (error.constructor?.name ?? "object") : typeof error}`);

    assert.strictEqual(error.code, expectedCode, `Expected ConnectError code ${expectedCode} but got ${error.code}`);

    if (messagePattern !== undefined && error.message.length > 1000) {
        assert.fail(`ConnectError message is unexpectedly long (${error.message.length} chars), refusing to match pattern`);
    }

    if (typeof messagePattern === "string") {
        assert.ok(error.message.includes(messagePattern), `ConnectError message "${error.message}" does not include "${messagePattern}"`);
    } else if (messagePattern instanceof RegExp) {
        assert.ok(messagePattern.test(error.message), `ConnectError message "${error.message}" does not match ${messagePattern}`);
    }
}
