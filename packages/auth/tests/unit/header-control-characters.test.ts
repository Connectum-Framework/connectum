/**
 * Control and special characters in identity text, on every path an `x-auth-*` text takes.
 *
 * Verdicts the table pins down (write = `setAuthHeaders`, read = `parseAuthHeaders` and the gateway
 * reader of the standard names, raw = value as sent, encoded = `utf-8''` plus percent-encoding):
 *
 * - NUL, CR, LF: refused on write; refused on read in every form, a percent-encoded `%00`, `%0D` or
 *   `%0A` included (a raw header cannot carry them at all).
 * - Other C0 controls and DEL: removed from subject, type and name on write, and removed on read in
 *   the raw and the decoded form alike; kept in a scope, which is written and read as granted.
 * - Tab: kept everywhere. C1 controls (U+0080 to U+009F): Latin-1, written and read unchanged.
 * - Everything above U+00FF (line and paragraph separators, BOM, bidi controls, zero-width joiner,
 *   emoji, Cyrillic, CJK): allowed, encoded on write, decoded to the identical text on read.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { encodeHeaderText, parseAuthHeaders, setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

const MARKER = "percent-utf8";
const base = { roles: [], scopes: [], claims: {}, type: "jwt" } as const;

type Field = "subject" | "name" | "type" | "scope";
const FIELDS: Field[] = ["subject", "name", "type", "scope"];

function contextWith(field: Field, text: string): AuthContext {
    return {
        ...base,
        subject: field === "subject" ? text : "s",
        ...(field === "name" ? { name: text } : {}),
        type: field === "type" ? text : "jwt",
        scopes: field === "scope" ? ["read", text] : [],
    };
}

function readBack(headers: Headers, field: Field): string | undefined {
    const parsed = parseAuthHeaders(headers);
    if (field === "scope") return parsed?.scopes[1];
    return parsed?.[field];
}

/** Headers as a foreign writer would send them: the given text in one field, percent-encoded with the marker. */
function encodedHeaders(field: Field, text: string): Headers {
    const headers = new Headers({ "x-auth-subject": "s", "x-auth-encoding": MARKER });
    const wire = `utf-8''${encodeURIComponent(text)}`;
    if (field === "subject") headers.set("x-auth-subject", wire);
    if (field === "name") headers.set("x-auth-name", wire);
    if (field === "type") headers.set("x-auth-type", wire);
    if (field === "scope") headers.set("x-auth-scopes", `read ${wire}`);
    return headers;
}

function rawHeaders(field: Field, text: string): Headers {
    const headers = new Headers({ "x-auth-subject": "s" });
    if (field === "subject") headers.set("x-auth-subject", text);
    if (field === "name") headers.set("x-auth-name", text);
    if (field === "type") headers.set("x-auth-type", text);
    if (field === "scope") headers.set("x-auth-scopes", `read ${text}`);
    return headers;
}

async function viaGateway(field: Field, text: string): Promise<AuthContext | undefined> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: { subject: "x-auth-subject", name: "x-auth-name", type: "x-auth-type", scopes: "x-auth-scopes" },
        trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
    });
    const req = createMockRequest({ service: "t.v1.S", method: "M" });
    for (const [name, value] of encodedHeaders(field, text)) req.header.set(name, value);
    req.header.set("x-gateway-secret", "s");
    let seen: AuthContext | undefined;
    await interceptor((async () => {
        seen = getAuthContext();
        return { message: {} };
    }) as never)(req);
    return seen;
}

function gatewayField(ctx: AuthContext | undefined, field: Field): string | undefined {
    if (field === "scope") return ctx?.scopes[1];
    return ctx?.[field];
}

describe("NUL, CR and LF", () => {
    for (const [label, char] of [["NUL", "\0"], ["CR", "\r"], ["LF", "\n"]] as const) {
        for (const field of FIELDS) {
            it(`${label} in ${field}: refused on write`, () => {
                assert.throws(() => setAuthHeaders(new Headers(), contextWith(field, `a${char}b`)), UnsafeHeaderValueError);
            });

            it(`${label} in ${field}: a percent-encoded one is refused by parseAuthHeaders and by the gateway reader`, async () => {
                assert.throws(
                    () => parseAuthHeaders(encodedHeaders(field, `a${char}b`)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                );
                await assert.rejects(
                    () => viaGateway(field, `a${char}b`),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                );
            });
        }

        it(`${label}: a raw header cannot carry it at all`, () => {
            assert.throws(() => new Headers({ "x-auth-subject": `a${char}b` }), TypeError);
        });
    }

    it("a refused text is also refused when it hides in a percent-encoded text with non-Latin characters", () => {
        assert.throws(() => parseAuthHeaders(encodedHeaders("subject", "Иван\nroot")), /./);
    });
});

describe("other C0 controls and DEL", () => {
    for (const char of ["\x01", "\x08", "\x0B", "\x0C", "\x1F", "\x7F"]) {
        const code = `U+${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
        for (const field of ["subject", "name", "type"] as const) {
            it(`${code} in ${field}: removed on write, and removed on read from the raw and the decoded form`, () => {
                const headers = new Headers();
                setAuthHeaders(headers, contextWith(field, `a${char}b`));
                assert.strictEqual(readBack(headers, field), "ab");
                assert.strictEqual(readBack(rawHeaders(field, `a${char}b`), field), "ab");
                assert.strictEqual(readBack(encodedHeaders(field, `a${char}b`), field), "ab");
            });
        }

        it(`${code} in a scope: written and read as granted, raw and decoded`, () => {
            const headers = new Headers();
            setAuthHeaders(headers, contextWith("scope", `a${char}b`));
            assert.strictEqual(readBack(headers, "scope"), `a${char}b`);
            assert.strictEqual(readBack(encodedHeaders("scope", `a${char}b`), "scope"), `a${char}b`);
        });
    }
});

describe("tab, C1 controls and the characters above U+00FF", () => {
    const allowed: Array<[string, string]> = [
        ["tab", "a\tb"],
        ["U+0080", "a\u0080b"],
        ["U+0085 (NEL)", "a\u0085b"],
        ["U+009F", "a\u009Fb"],
        ["U+00FF", "aÿb"],
        ["U+2028 line separator", "a b"],
        ["U+2029 paragraph separator", "a b"],
        ["U+FEFF byte order mark", "﻿ab"],
        ["U+202E right-to-left override", "a‮b"],
        ["U+200D zero-width joiner", "a‍b"],
        ["emoji with a joiner", "\u{1F468}‍\u{1F4BB}"],
        ["Cyrillic name", "Иван Петров"],
        ["CJK name", "李雷"],
        ["Latin-1 and Polish", "Łukasz Müller"],
    ];

    for (const [label, text] of allowed) {
        for (const field of FIELDS) {
            const value = field === "scope" ? text.replaceAll(" ", "-") : text;
            it(`${label} in ${field}: round-trips through setAuthHeaders and parseAuthHeaders`, () => {
                const headers = new Headers();
                setAuthHeaders(headers, contextWith(field, value));
                for (const [, wire] of headers) assert.ok(/^[\x00-\xFF]*$/.test(wire), "every header value is a byte string");
                assert.strictEqual(readBack(headers, field), value);
            });
        }

        it(`${label}: the gateway reader of the standard names gives the same text`, async () => {
            for (const field of FIELDS) {
                const value = field === "scope" ? text.replaceAll(" ", "-") : text;
                assert.strictEqual(gatewayField(await viaGateway(field, value), field), value);
            }
        });
    }

    it("a text that needs no encoding is written unchanged and needs no marker", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "a\tb\u0085c" });
        assert.strictEqual(headers.get("x-auth-subject"), "a\tb\u0085c");
        assert.strictEqual(headers.get("x-auth-encoding"), null);
        assert.strictEqual(encodeHeaderText("a\tb\u0085c"), "a\tb\u0085c");
    });
});
