/**
 * Unit tests for mapping a reflection `ErrorResponse.error_code` to a Connect code.
 *
 * A server may send any int32 in `error_code`. Passing it through unchecked would
 * produce a `ConnectError` whose code Connect does not define (0 or out of range),
 * which then misleads every caller that compares codes, such as the v1 → v1alpha
 * fallback on `Unimplemented`.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { reflectionErrorCode } from "../../src/utils/reflectionErrorCode.ts";

describe("reflectionErrorCode", () => {
    it("passes every gRPC status code 1–16 through unchanged", () => {
        for (let code = 1; code <= 16; code++) {
            assert.strictEqual(reflectionErrorCode(code), code);
        }
        assert.strictEqual(reflectionErrorCode(12), Code.Unimplemented);
        assert.strictEqual(reflectionErrorCode(5), Code.NotFound);
    });

    it("maps 0 (OK), which Connect has no code for, to Unknown", () => {
        assert.strictEqual(reflectionErrorCode(0), Code.Unknown);
    });

    it("maps negative, out-of-range and non-integer values to Unknown", () => {
        for (const value of [-1, 17, 999, 2.5, Number.NaN]) {
            assert.strictEqual(reflectionErrorCode(value), Code.Unknown, `value ${value}`);
        }
    });
});
