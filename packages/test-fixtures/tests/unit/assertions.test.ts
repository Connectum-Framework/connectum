/**
 * Unit tests for assertConnectError assertion helper.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError } from "../../src/assertions.ts";

describe("assertConnectError", () => {
    it("passes for correct ConnectError with matching code", () => {
        const error = new ConnectError("something went wrong", Code.NotFound);
        assertConnectError(error, Code.NotFound);
    });

    it("passes with string messagePattern that matches", () => {
        const error = new ConnectError("user not found", Code.NotFound);
        assertConnectError(error, Code.NotFound, "user not found");
    });

    it("passes with RegExp messagePattern that matches", () => {
        const error = new ConnectError("user not found", Code.NotFound);
        assertConnectError(error, Code.NotFound, /user not found/);
    });

    it("throws for non-ConnectError (plain Error)", () => {
        const error = new Error("plain error");
        assert.throws(
            () => assertConnectError(error, Code.Internal),
            (err: unknown) => {
                assert.ok(err instanceof assert.AssertionError);
                assert.ok(
                    (err as assert.AssertionError).message.includes(
                        "Expected ConnectError but got Error",
                    ),
                );
                return true;
            },
        );
    });

    it("throws for non-Error values (string, null, undefined, number)", () => {
        for (const value of ["a string", null, undefined, 42]) {
            assert.throws(
                () => assertConnectError(value, Code.Internal),
                (err: unknown) => {
                    assert.ok(err instanceof assert.AssertionError);
                    return true;
                },
            );
        }
    });

    it("throws for wrong code", () => {
        const error = new ConnectError("forbidden", Code.PermissionDenied);
        assert.throws(
            () => assertConnectError(error, Code.Unauthenticated),
            (err: unknown) => {
                assert.ok(err instanceof assert.AssertionError);
                const msg = (err as assert.AssertionError).message;
                assert.ok(msg.includes("Expected ConnectError code"));
                return true;
            },
        );
    });

    it("throws for non-matching string pattern", () => {
        const error = new ConnectError("user not found", Code.NotFound);
        assert.throws(
            () => assertConnectError(error, Code.NotFound, "order not found"),
            (err: unknown) => {
                assert.ok(err instanceof assert.AssertionError);
                assert.ok(
                    (err as assert.AssertionError).message.includes(
                        "does not include",
                    ),
                );
                return true;
            },
        );
    });

    it("throws for non-matching RegExp pattern", () => {
        const error = new ConnectError("user not found", Code.NotFound);
        assert.throws(
            () =>
                assertConnectError(
                    error,
                    Code.NotFound,
                    /^exact match only$/,
                ),
            (err: unknown) => {
                assert.ok(err instanceof assert.AssertionError);
                assert.ok(
                    (err as assert.AssertionError).message.includes(
                        "does not match",
                    ),
                );
                return true;
            },
        );
    });

    it("works without messagePattern (code-only check)", () => {
        const error = new ConnectError(
            "some detailed error message",
            Code.Internal,
        );
        assertConnectError(error, Code.Internal);
        // No throw — assertion passed with code-only check
    });

    it("narrows type after assertion — error.code is accessible without cast", () => {
        const error: unknown = new ConnectError("typed", Code.AlreadyExists);
        assertConnectError(error, Code.AlreadyExists);

        // After assertion, TypeScript narrows error to ConnectError.
        // Accessing .code and .message without cast proves type narrowing works.
        assert.strictEqual(error.code, Code.AlreadyExists);
        assert.ok(error.message.includes("typed"));
    });

    it("matches ConnectError message format [code] message", () => {
        // ConnectError prefixes messages like "[not_found] user not found"
        const error = new ConnectError("user not found", Code.NotFound);

        // String pattern should match within the full message
        assertConnectError(error, Code.NotFound, "user not found");

        // RegExp can match more flexibly
        assertConnectError(error, Code.NotFound, /not_found.*user not found/);
        assertConnectError(error, Code.NotFound, /user not found/);
    });
});
