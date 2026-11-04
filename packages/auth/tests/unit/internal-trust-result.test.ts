/**
 * A custom trust source of the internal-auth interceptor returns an identity the interceptor then
 * runs the handler under. Anything that is not an `AuthContext` (a truthy `true`, `{}`, a context
 * with a sparse `roles` list) is not trusted: the call ends with `Unauthenticated` and the text of
 * an untrusted request, the handler does not run, and a trust source that throws does the same.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createInternalAuthInterceptor } from "../../src/internal-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

const NOT_IDENTITIES: Array<[string, unknown]> = [
    ["true", true],
    ["an empty object", {}],
    ["a string", "alice"],
    ["a context with a sparse roles list", { ...createMockAuthContext(), roles: ["a", , "b"] }], // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    ["a context with a numeric subject", { ...createMockAuthContext(), subject: 7 }],
    [
        "a context whose getter throws",
        Object.defineProperty({}, "subject", {
            get() {
                throw new Error("boom");
            },
        }),
    ],
];

/** Interceptor with a custom trust source that answers `result` for every internal call. */
function interceptorTrusting(result: unknown) {
    return createInternalAuthInterceptor({ internalMethods: ["t.v1.S/M"], trustSource: async () => result as never });
}

describe("custom trust source result", () => {
    for (const [label, value] of NOT_IDENTITIES) {
        it(`${label} is not trusted`, async () => {
            const next = createMockNext();
            await assert.rejects(
                () => interceptorTrusting(value)(next)(createMockRequest({ service: "t.v1.S", method: "M" })),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Untrusted internal request");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });
    }

    it("a well-formed identity is trusted and reaches the handler", async () => {
        let seen: string | undefined;
        const interceptor = interceptorTrusting(createMockAuthContext({ subject: "svc" }));
        await interceptor((async () => {
            seen = getAuthContext()?.subject;
            return { message: {} };
        }) as never)(createMockRequest({ service: "t.v1.S", method: "M" }));
        assert.strictEqual(seen, "svc");
    });
});
