/**
 * Exact trust values: the comparison result is unchanged by the constant-time implementation.
 *
 * The gateway trust header is compared with each `expectedValues` entry through fixed-size
 * digests. Whatever the implementation, equal texts must match and every other text must not,
 * including texts that are prefixes of each other, differ in length, hold non-ASCII characters
 * or lone surrogates (which a UTF-8 digest would collapse into one replacement character), and
 * secrets that contain `/` without being a CIDR block.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";

async function admits(expectedValues: string[], headerValue: string): Promise<boolean> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: { subject: "x-user-id" },
        trustSource: { header: "x-gateway-secret", expectedValues },
    });
    const next = mock.fn(async () => ({ message: {} }));
    // `Headers` refuses characters above U+00FF, so the in-process request carries a plain stand-in.
    const request = createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ "x-user-id": "user" }) });
    const original = request.header.get.bind(request.header);
    request.header.get = (name: string) => (name === "x-gateway-secret" ? headerValue : original(name));
    try {
        await interceptor(next as never)(request);
    } catch {
        return false;
    }
    return next.mock.calls.length === 1;
}

describe("gateway trust: exact values", () => {
    it("matches equal texts, including the second of several entries", async () => {
        assert.strictEqual(await admits(["s3cret"], "s3cret"), true);
        assert.strictEqual(await admits(["other", "s3cret"], "s3cret"), true);
    });

    it("rejects a prefix, an extension, another case and the empty text", async () => {
        for (const guess of ["s3cre", "s3crets", "S3CRET", "s3cret ", " s3cret", ""]) {
            assert.strictEqual(await admits(["s3cret"], guess), false, JSON.stringify(guess));
        }
    });

    it("compares non-ASCII text exactly", async () => {
        assert.strictEqual(await admits(["clé-секрет"], "clé-секрет"), true);
        assert.strictEqual(await admits(["clé-секрет"], "cle-секрет"), false);
    });

    it("keeps lone surrogates distinct", async () => {
        assert.strictEqual(await admits(["\uD800"], "\uD801"), false);
        assert.strictEqual(await admits(["\uD800"], "\uD800"), true);
    });

    it("matches a secret that contains a slash only by its exact text", async () => {
        assert.strictEqual(await admits(["ab/cd"], "ab/cd"), true);
        assert.strictEqual(await admits(["10.0.0.0/33"], "10.0.0.0/33"), true);
        assert.strictEqual(await admits(["10.0.0.0/33"], "10.0.0.1"), false);
    });
});
