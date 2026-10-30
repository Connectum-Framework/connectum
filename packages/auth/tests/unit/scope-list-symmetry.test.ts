/**
 * Scopes and roles survive the write and the read unchanged, or the write refuses them.
 *
 * Scopes travel in one header joined by single spaces, and the reader splits that header on spaces
 * and drops empty pieces. An empty scope therefore used to vanish (`["a", "", "b"]` was written as
 * `a  b` and read as `["a", "b"]`) and `[""]` was written as an empty header and read as no
 * scopes. A scope may not be empty or contain a space: the writer refuses it, as it refuses a
 * space, and every accepted list reads back as written. Roles are JSON, so empty and blank roles
 * round-trip as they are. The reader stays tolerant of what other writers send (doubled, leading
 * or trailing spaces), which no Connectum writer produces.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { parseAuthHeaders, setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";
import type { AuthContext } from "../../src/types.ts";

const REFUSED: Array<[string, string[]]> = [
    ["a single empty scope", [""]],
    ["an empty scope between two", ["a", "", "b"]],
    ["an empty scope first", ["", "a"]],
    ["an empty scope last", ["a", ""]],
    ["two empty scopes", ["", ""]],
    ["a scope with a space", ["a b"]],
    ["a scope that is one space", [" "]],
];

const ACCEPTED: Array<[string, string[]]> = [
    ["no scopes", []],
    ["one scope", ["a"]],
    ["several scopes", ["read", "write", "x:y"]],
    ["a scope with an inner tab", ["a\tb"]],
    ["a scope with a leading tab", ["\ta", "b"]],
    ["a scope that is one tab", ["\t"]],
    ["a non-Latin scope", ["чтение", "读取"]],
    ["a scope that starts with the encoding prefix", ["utf-8''x"]],
    ["a Latin-1 scope", ["café"]],
];

function contextWith(scopes: string[], roles: string[] = []): AuthContext {
    return { ...createMockAuthContext(), scopes, roles, claims: {}, name: undefined };
}

describe("scopes the writer refuses", () => {
    for (const [label, scopes] of REFUSED) {
        it(`setAuthHeaders refuses ${label} and writes no header`, () => {
            const out = new Headers();
            assert.throws(
                () => setAuthHeaders(out, contextWith(scopes)),
                (err: unknown) => err instanceof UnsafeHeaderValueError && err.field === "scopes" && /empty or contain a space/.test(err.message),
            );
            assert.deepStrictEqual([...out.keys()], []);
        });

        for (const kind of ["generic", "session"] as const) {
            it(`${kind} interceptor: ${label} is Unauthenticated when propagated and admitted when not`, async () => {
                const make = (propagateHeaders: boolean) =>
                    kind === "generic"
                        ? createAuthInterceptor({ verifyCredentials: async () => contextWith(scopes), propagateHeaders, cache: { ttl: 60_000 } })
                        : createSessionAuthInterceptor({ verifySession: async () => ({}), mapSession: async () => contextWith(scopes), propagateHeaders, cache: { ttl: 60_000 } });
                const request = () => createMockRequest({ headers: new Headers({ authorization: "Bearer t" }) });

                const next = createMockNext();
                await assert.rejects(
                    () => make(true)(next)(request()),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);

                await make(false)(next)(request());
                assert.strictEqual(next.mock.calls.length, 1);
            });
        }
    }
});

describe("round trip of every accepted list", () => {
    for (const [label, scopes] of ACCEPTED) {
        it(`${label}: setAuthHeaders then parseAuthHeaders gives the same scopes`, () => {
            const headers = new Headers();
            setAuthHeaders(headers, contextWith(scopes));
            assert.deepStrictEqual(parseAuthHeaders(headers)?.scopes, scopes);
        });

        it(`${label}: the gateway reader of the standard names gives the same scopes`, async () => {
            const headers = new Headers();
            setAuthHeaders(headers, contextWith(scopes));
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-auth-subject", scopes: "x-auth-scopes" },
                trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
            });
            const req = createMockRequest({ service: "t.v1.S", method: "M" });
            for (const [name, value] of headers) req.header.set(name, value);
            req.header.set("x-gateway-secret", "s");
            let seen: readonly string[] | undefined;
            await interceptor((async () => {
                seen = getAuthContext()?.scopes;
                return { message: {} };
            }) as never)(req);
            assert.deepStrictEqual(seen, scopes);
        });
    }

    it("roles that are empty, blank or hold spaces round-trip through JSON", () => {
        const roles = ["", " ", "a b", "\t", "x"];
        const headers = new Headers();
        setAuthHeaders(headers, contextWith([], roles));
        assert.deepStrictEqual(parseAuthHeaders(headers)?.roles, roles);
    });
});

describe("the reader is tolerant of other writers", () => {
    it("reads doubled, leading and trailing spaces as separators and an empty header as no scopes", () => {
        const read = (value: string): readonly string[] | undefined => parseAuthHeaders(new Headers({ "x-auth-subject": "s", "x-auth-scopes": value }))?.scopes;
        assert.deepStrictEqual(read("a  b"), ["a", "b"]);
        assert.deepStrictEqual(read(" a b "), ["a", "b"]);
        assert.deepStrictEqual(read(""), []);
    });
});
