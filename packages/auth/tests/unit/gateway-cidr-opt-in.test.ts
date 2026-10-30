/**
 * CIDR blocks in the gateway trust list need an explicit opt-in.
 *
 * A block is matched against the value of a header that a caller reaching the service directly
 * chooses itself, so `10.0.0.0/8` admits anyone who sends `10.9.9.9`. Creating the interceptor
 * with a block and without `allowCallerControlledCidr: true` throws and the message says why.
 * Shared secrets, including ones that contain a slash, are not affected.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";

const base = { headerMapping: { subject: "x-user" } };

/** Gateway interceptor for the given trust list; the opt-in is passed only when given. */
function create(expectedValues: string[], allowCallerControlledCidr?: boolean) {
    return createGatewayAuthInterceptor({
        ...base,
        trustSource: { header: "x-gateway-source", expectedValues, ...(allowCallerControlledCidr === undefined ? {} : { allowCallerControlledCidr }) },
    });
}

describe("gateway trust: CIDR opt-in", () => {
    for (const block of ["10.0.0.0/8", "0.0.0.0/0", "192.168.1.0/24", "1.2.3.4/32"]) {
        it(`throws at creation for ${block} without the opt-in, naming the block and the header`, () => {
            assert.throws(
                () => create(["s3cret-value", block]),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes(block), err.message);
                    assert.ok(err.message.includes("x-gateway-source"), err.message);
                    assert.ok(err.message.includes("caller") && err.message.includes("chooses"), err.message);
                    assert.ok(err.message.includes("allowCallerControlledCidr"), err.message);
                    return true;
                },
            );
        });
    }

    it("throws for allowCallerControlledCidr set to anything but true", () => {
        assert.throws(() => create(["10.0.0.0/8"], false), /allowCallerControlledCidr/);
        assert.throws(() => create(["10.0.0.0/8"], "yes" as unknown as boolean), /allowCallerControlledCidr/);
    });

    it("creates the interceptor and matches the block with the opt-in", async () => {
        const next = mock.fn(async () => ({ message: {} }));
        const handler = create(["10.0.0.0/8"], true)(next as never);
        await handler(createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ "x-gateway-source": "10.9.9.9", "x-user": "u" }) }));
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("does not touch shared secrets, also ones that contain a slash or look like a malformed block", async () => {
        for (const secret of ["plain-secret", "ab/cd", "10.0.0.0/33", "10.0.0.0/abc", "a/b/c"]) {
            const next = mock.fn(async () => ({ message: {} }));
            const handler = create([secret])(next as never);
            await handler(createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ "x-gateway-source": secret, "x-user": "u" }) }));
            assert.strictEqual(next.mock.calls.length, 1, secret);
        }
    });

    it("a direct caller that guesses an address is rejected when the trust list is a shared secret", async () => {
        const handler = create(["s3cret-value"])(mock.fn(async () => ({ message: {} })) as never);
        for (const guess of ["10.9.9.9", "0.0.0.0/0", "guess"]) {
            await assert.rejects(
                () => handler(createMockRequest({ service: "t.v1.S", method: "M", headers: new Headers({ "x-gateway-source": guess, "x-user": "admin" }) })),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Untrusted request source");
                    return true;
                },
            );
        }
    });
});
