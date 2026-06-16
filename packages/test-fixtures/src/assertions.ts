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

    // Match against a length-bounded slice. The guard above already fails on
    // messages > 1000 chars, so this slice is a no-op for valid inputs; it makes
    // the bound explicit at the match site (bounded-input mitigation — it caps
    // the matched length, not regex complexity, so a catastrophic caller-supplied
    // pattern can still be slow on 1000 chars; the pattern here is test-author
    // controlled, not attacker input).
    const haystack = error.message.slice(0, 1000);
    if (typeof messagePattern === "string") {
        assert.ok(haystack.includes(messagePattern), `ConnectError message "${error.message}" does not include "${messagePattern}"`);
    } else if (messagePattern instanceof RegExp) {
        assert.ok(messagePattern.test(haystack), `ConnectError message "${error.message}" does not match ${messagePattern}`);
    }
}
