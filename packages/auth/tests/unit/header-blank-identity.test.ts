/**
 * An identity value that is empty only after the control characters are removed.
 *
 * Subject, type and name lose C0 controls and DEL when they are written and read. A value that
 * consists of nothing else therefore becomes the empty string, which the reader treats as no
 * value: no identity at all for a subject, the type "unknown" for a type. An identity without a
 * subject was never valid, so the writer refuses it as it refuses an empty one, and the reader
 * reports no identity for such headers. The gateway interceptor already answered
 * `Unauthenticated` for that subject; it must keep doing so.
 *
 * The neighbours at the end pin what must not change: a control character between other
 * characters is still removed (`a\x01b` becomes `ab`), and a subject of spaces or of a tab is
 * still an identity, because neither character is a control character the cleaning removes.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { parseAuthHeaders, setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

const MARKER = "percent-utf8";
/** An identity with plain values, so that only the field under test can change the outcome. */
const base = { subject: "s", roles: [], scopes: [], claims: {}, type: "jwt" } as const;
/** One control character per range the cleaning removes: C0 except tab, and DEL. */
const CONTROLS = ["\x01", "\x08", "\x0B", "\x0C", "\x0E", "\x1F", "\x7F"];

/** The entries of a `Headers` object, comparable with `deepStrictEqual`. */
function entries(headers: Headers): Array<[string, string]> {
    return [...headers];
}

/** The value a writer that encodes text sends for a text that is empty after sanitising. */
function encodedText(text: string): string {
    return `utf-8''${encodeURIComponent(text)}`;
}

/** Runs the gateway interceptor over the headers; resolves to the identity the handler saw. */
async function viaGateway(headers: Headers): Promise<AuthContext | undefined> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: { subject: "x-auth-subject", type: "x-auth-type" },
        trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
    });
    const req = createMockRequest({ service: "t.v1.S", method: "M" });
    for (const [name, value] of headers) req.header.set(name, value);
    req.header.set("x-gateway-secret", "s");
    let seen: AuthContext | undefined;
    await interceptor((async () => {
        seen = getAuthContext();
        return { message: {} };
    }) as never)(req);
    return seen;
}

describe("a subject or type that is empty after sanitising is what an empty value is", () => {
    const cases: Array<[string, "subject" | "type", Partial<AuthContext>]> = [
        ["a subject of one control character", "subject", { subject: "\x01" }],
        ["a subject of several control characters", "subject", { subject: "\x01\x0E\x7F" }],
        ["a type of one control character", "type", { type: "\x01" }],
        ["a type of several control characters", "type", { type: "\x0B\x0C\x7F" }],
    ];

    for (const [label, field, patch] of cases) {
        it(`${label}: the writer throws the error it throws for an empty ${field} and leaves the headers untouched`, () => {
            const headers = new Headers({ "x-pre-existing": "kept" });
            const before = entries(headers);
            assert.throws(
                () => setAuthHeaders(headers, { ...base, ...patch }),
                (err: unknown) => err instanceof UnsafeHeaderValueError && err.field === field && /must not be empty/.test(err.message),
                "an identity that reads back without a subject or type is refused, not written",
            );
            assert.deepStrictEqual(entries(headers), before, "a refused identity leaves the headers exactly as they were");
        });
    }
});

describe("a header that is empty after sanitising is read as no value", () => {
    for (const control of CONTROLS) {
        const code = `U+${control.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;

        it(`a raw subject of ${code} only: no identity`, () => {
            assert.strictEqual(parseAuthHeaders(new Headers({ "x-auth-subject": control })), undefined);
        });

        it(`an encoded subject of ${code} only: no identity`, () => {
            const headers = new Headers({ "x-auth-subject": encodedText(control), "x-auth-encoding": MARKER });
            assert.strictEqual(parseAuthHeaders(headers), undefined);
        });

        it(`a raw type of ${code} only: the type "unknown", as for an empty type header`, () => {
            const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": control });
            assert.strictEqual(parseAuthHeaders(headers)?.type, "unknown");
        });

        it(`an encoded type of ${code} only: the type "unknown"`, () => {
            const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": encodedText(control), "x-auth-encoding": MARKER });
            assert.strictEqual(parseAuthHeaders(headers)?.type, "unknown");
        });
    }
});

describe("the gateway interceptor with the same headers", () => {
    for (const control of CONTROLS) {
        const code = `U+${control.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;

        it(`a raw subject of ${code} only: Unauthenticated`, async () => {
            const headers = new Headers({ "x-auth-subject": control });
            await assert.rejects(
                () => viaGateway(headers),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Missing subject header from gateway");
                    return true;
                },
            );
        });

        it(`an encoded subject of ${code} only: Unauthenticated`, async () => {
            const headers = new Headers({ "x-auth-subject": encodedText(control), "x-auth-encoding": MARKER });
            await assert.rejects(
                () => viaGateway(headers),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Missing subject header from gateway");
                    return true;
                },
            );
        });

        it(`a raw type of ${code} only, with a valid subject: the empty type it reads today`, async () => {
            const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": control });
            assert.strictEqual((await viaGateway(headers))?.type, "");
        });
    }
});

describe("neighbours that must not change", () => {
    it("a control character between other characters is removed: a\\x01b is written and read as ab", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "a\x01b" });
        assert.strictEqual(headers.get("x-auth-subject"), "ab");
        assert.strictEqual(parseAuthHeaders(headers)?.subject, "ab");
    });

    it("a subject of spaces only is an identity", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "   " });
        assert.strictEqual(parseAuthHeaders(headers)?.subject, "   ");
    });

    it("a subject of a tab only is an identity", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "\t" });
        assert.strictEqual(parseAuthHeaders(headers)?.subject, "\t");
    });

    // The platform trims a space or tab at either end of a header value, so the writer sends
    // such a subject encoded; the gateway reads the form the writer sends.
    it("a subject of spaces only reaches the handler through the gateway as those spaces", async () => {
        const headers = new Headers({ "x-auth-subject": encodedText("   "), "x-auth-encoding": MARKER });
        assert.strictEqual((await viaGateway(headers))?.subject, "   ");
    });

    it("a subject of a tab only reaches the handler through the gateway as that tab", async () => {
        const headers = new Headers({ "x-auth-subject": encodedText("\t"), "x-auth-encoding": MARKER });
        assert.strictEqual((await viaGateway(headers))?.subject, "\t");
    });

    it("an empty subject header yields no identity", () => {
        assert.strictEqual(parseAuthHeaders(new Headers({ "x-auth-subject": "" })), undefined);
    });

    it("a missing subject header yields no identity", () => {
        assert.strictEqual(parseAuthHeaders(new Headers({ "x-auth-type": "jwt" })), undefined);
    });
});
