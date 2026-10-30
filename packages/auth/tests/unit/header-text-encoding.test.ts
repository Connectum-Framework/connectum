/**
 * Identity text above U+00FF travels without loss.
 *
 * A header value is a byte string, so a subject, name, type or scope with Cyrillic, CJK or an
 * emoji cannot be written as is. It is written as `utf-8''` plus percent-encoded UTF-8 and read
 * back by the receiver. Text up to U+00FF is not touched, so the wire form of every identity that
 * could be propagated before is unchanged.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { decodeHeaderText, encodeHeaderText, parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

const TEXTS = ["Иван", "Łukasz", "李雷", "user-\u{1F600}", "a b", "ひらがな and ASCII", "café Москва"];

const base = { roles: [], scopes: [], claims: {}, type: "jwt" } as const;

describe("encodeHeaderText / decodeHeaderText", () => {
    it("leaves ASCII and Latin-1 text unchanged", () => {
        for (const text of ["alice", "user-1", "café", "Zoë", "a\tb", "", "x y"]) {
            assert.strictEqual(encodeHeaderText(text), text);
        }
    });

    it("writes text above U+00FF as utf-8'' plus percent-encoded UTF-8, byte-string safe", () => {
        assert.strictEqual(encodeHeaderText("Иван"), "utf-8''%D0%98%D0%B2%D0%B0%D0%BD");
        assert.strictEqual(encodeHeaderText("李雷"), "utf-8''%E6%9D%8E%E9%9B%B7");
        for (const text of TEXTS) assert.ok(/^[\x00-\xFF]*$/.test(encodeHeaderText(text)), text);
    });

    it("round-trips Cyrillic, CJK, emoji and mixed text", () => {
        for (const text of TEXTS) assert.strictEqual(decodeHeaderText(encodeHeaderText(text)), text);
    });

    it("encodes a text that itself starts with the prefix, so reading is unambiguous", () => {
        const text = "utf-8''%D0%98";
        assert.notStrictEqual(encodeHeaderText(text), text);
        assert.strictEqual(decodeHeaderText(encodeHeaderText(text)), text);
    });

    it("keeps different texts different on the wire", () => {
        const wire = new Set(TEXTS.map(encodeHeaderText));
        assert.strictEqual(wire.size, TEXTS.length);
    });

    it("refuses a lone surrogate when writing and malformed percent-encoding when reading", () => {
        assert.throws(() => encodeHeaderText("a\uD800"), URIError);
        assert.throws(() => decodeHeaderText("utf-8''%E0%A4%A"), URIError);
        assert.throws(() => decodeHeaderText("utf-8''%FF%FE"), URIError);
    });
});

describe("setAuthHeaders / parseAuthHeaders with text above U+00FF", () => {
    for (const text of TEXTS) {
        it(`round-trips subject, name, type and a scope of ${JSON.stringify(text)}`, () => {
            const headers = new Headers();
            const context: AuthContext = { subject: text, name: text, type: `t-${text}`, roles: [], scopes: ["read", text.replaceAll(" ", "-")], claims: {} };
            setAuthHeaders(headers, context);

            for (const [, value] of headers) assert.ok(/^[\x00-\xFF]*$/.test(value), "every header value is a byte string");
            assert.deepStrictEqual(parseAuthHeaders(headers), context);
        });
    }

    it("keeps two different non-Latin subjects different downstream", () => {
        const a = new Headers();
        const b = new Headers();
        setAuthHeaders(a, { ...base, subject: "Иван-A" });
        setAuthHeaders(b, { ...base, subject: "Иван-B" });
        assert.notStrictEqual(a.get("x-auth-subject"), b.get("x-auth-subject"));
        assert.strictEqual(parseAuthHeaders(a)?.subject, "Иван-A");
        assert.strictEqual(parseAuthHeaders(b)?.subject, "Иван-B");
    });

    it("writes ASCII and Latin-1 identities exactly as before", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { subject: "café", name: "Zoë", type: "jwt", roles: ["r"], scopes: ["lecture-é", "read"], claims: { k: "v" } });
        assert.deepStrictEqual(Object.fromEntries(headers), {
            "x-auth-subject": "café",
            "x-auth-type": "jwt",
            "x-auth-name": "Zoë",
            "x-auth-roles": '["r"]',
            "x-auth-scopes": "lecture-é read",
            "x-auth-claims": '{"k":"v"}',
        });
    });

    // A service that never sends the marker (an older version, another gateway) may send a subject
    // that literally starts with the prefix; reading it as encoded text would turn it into another identity.
    it("reads a literal utf-8'' subject as is when the sender did not declare the encoding", () => {
        const headers = new Headers({ "x-auth-subject": "utf-8''admin", "x-auth-name": "utf-8''%D0%98", "x-auth-scopes": "utf-8''read" });
        const parsed = parseAuthHeaders(headers);
        assert.strictEqual(parsed?.subject, "utf-8''admin");
        assert.strictEqual(parsed?.name, "utf-8''%D0%98");
        assert.deepStrictEqual(parsed?.scopes, ["utf-8''read"]);
    });

    it("sets the encoding marker only when it encoded something", () => {
        const plain = new Headers();
        setAuthHeaders(plain, { ...base, subject: "alice", name: "Zoë" });
        assert.strictEqual(plain.get("x-auth-encoding"), null);

        const encoded = new Headers();
        setAuthHeaders(encoded, { ...base, subject: "Иван" });
        assert.strictEqual(encoded.get("x-auth-encoding"), "percent-utf8");

        const prefixed = new Headers();
        setAuthHeaders(prefixed, { ...base, subject: "utf-8''admin" });
        assert.strictEqual(prefixed.get("x-auth-encoding"), "percent-utf8");
        assert.strictEqual(parseAuthHeaders(prefixed)?.subject, "utf-8''admin");
    });

    it("refuses a malformed encoded subject on read", () => {
        const headers = new Headers({ "x-auth-subject": "utf-8''%E0%A4%A", "x-auth-encoding": "percent-utf8" });
        assert.throws(
            () => parseAuthHeaders(headers),
            (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                return true;
            },
        );
    });

    it("applies the length limit to the text, not to the encoded form", () => {
        const headers = new Headers();
        const subject = "Я".repeat(512);
        setAuthHeaders(headers, { ...base, subject });
        assert.strictEqual(parseAuthHeaders(headers)?.subject, subject);
        assert.throws(() => setAuthHeaders(new Headers(), { ...base, subject: `${subject}Я` }), RangeError);
    });
});

describe("gateway interceptor reading x-auth-* text", () => {
    /** Gateway interceptor with the given header mapping and a shared-secret trust header. */
    function chain(mapping: { subject: string; name: string; scopes: string }) {
        return createGatewayAuthInterceptor({
            headerMapping: mapping,
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
        });
    }

    it("decodes the standard x-auth-* names written by another service", async () => {
        let seen: AuthContext | undefined;
        const interceptor = chain({ subject: "x-auth-subject", name: "x-auth-name", scopes: "x-auth-scopes" });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        setAuthHeaders(req.header, { ...base, subject: "Иван", name: "李雷", scopes: ["read", "чтение"] });
        req.header.set("x-gateway-secret", "s");

        await interceptor((async () => {
            seen = getAuthContext();
            return { message: {} };
        }) as never)(req);

        assert.strictEqual(seen?.subject, "Иван");
        assert.strictEqual(seen?.name, "李雷");
        assert.deepStrictEqual(seen?.scopes, ["read", "чтение"]);
    });

    it("takes a custom header as it is, even when it looks like encoded text", async () => {
        let seen: AuthContext | undefined;
        const interceptor = chain({ subject: "x-user-id", name: "x-user-name", scopes: "x-user-scopes" });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        req.header.set("x-gateway-secret", "s");
        req.header.set("x-user-id", "utf-8''%D0%98");
        req.header.set("x-user-name", "utf-8''%D0%98");

        await interceptor((async () => {
            seen = getAuthContext();
            return { message: {} };
        }) as never)(req);

        assert.strictEqual(seen?.subject, "utf-8''%D0%98");
        assert.strictEqual(seen?.name, "utf-8''%D0%98");
    });

    it("accepts a defaultType above U+00FF and propagates it encoded", async () => {
        const interceptor = createGatewayAuthInterceptor({
            headerMapping: { subject: "x-user-id" },
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
            defaultType: "шлюз",
            propagateHeaders: true,
        });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        req.header.set("x-gateway-secret", "s");
        req.header.set("x-user-id", "u");

        await interceptor((async () => ({ message: {} })) as never)(req);

        assert.strictEqual(req.header.get("x-auth-type"), encodeHeaderText("шлюз"));
        assert.strictEqual(parseAuthHeaders(req.header)?.type, "шлюз");
    });

    it("still refuses a defaultType with NUL, CR or LF when the interceptor is created", () => {
        for (const defaultType of ["a\nb", "a\rb", "a\0b"]) {
            assert.throws(
                () => createGatewayAuthInterceptor({ headerMapping: { subject: "x" }, trustSource: { header: "h", expectedValues: ["s"] }, defaultType }),
                /defaultType/,
            );
        }
    });

    it("keeps a literal utf-8'' subject from a sender that did not declare the encoding", async () => {
        let seen: AuthContext | undefined;
        const interceptor = chain({ subject: "x-auth-subject", name: "x-auth-name", scopes: "x-auth-scopes" });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        req.header.set("x-gateway-secret", "s");
        req.header.set("x-auth-subject", "utf-8''admin");

        await interceptor((async () => {
            seen = getAuthContext();
            return { message: {} };
        }) as never)(req);

        assert.strictEqual(seen?.subject, "utf-8''admin");
    });

    it("refuses a malformed encoded subject", async () => {
        const interceptor = chain({ subject: "x-auth-subject", name: "x-auth-name", scopes: "x-auth-scopes" });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        req.header.set("x-gateway-secret", "s");
        req.header.set("x-auth-encoding", "percent-utf8");
        req.header.set("x-auth-subject", "utf-8''%E0%A4%A");
        const next = mock.fn(async () => ({ message: {} }));

        await assert.rejects(
            () => interceptor(next as never)(req),
            (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 0);
    });
});

describe("createClientGatewayInterceptor", () => {
    /** Headers the client gateway interceptor puts on an outgoing request for `subject` and `roles`. */
    async function headersFor(subject: string, roles?: string[]): Promise<Headers> {
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        await createClientGatewayInterceptor({ secret: "s", subject, ...(roles ? { roles } : {}) })((async () => ({ message: {} })) as never)(req);
        return req.header;
    }

    it("writes a non-Latin subject encoded and an ASCII subject unchanged", async () => {
        assert.strictEqual((await headersFor("сервис")).get("x-auth-subject"), encodeHeaderText("сервис"));
        assert.strictEqual((await headersFor("order-service")).get("x-auth-subject"), "order-service");
    });

    it("declares the encoding only when it encoded the subject", async () => {
        assert.strictEqual((await headersFor("сервис")).get("x-auth-encoding"), "percent-utf8");
        assert.strictEqual((await headersFor("order-service")).get("x-auth-encoding"), null);
    });

    it("keeps a marker already on the request when it writes an ASCII subject", async () => {
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        setAuthHeaders(req.header, { ...base, subject: "x", scopes: ["чтение"] });
        await createClientGatewayInterceptor({ secret: "s", subject: "order-service" })((async () => ({ message: {} })) as never)(req);
        assert.strictEqual(req.header.get("x-auth-encoding"), "percent-utf8");
        assert.deepStrictEqual(parseAuthHeaders(req.header)?.scopes, ["чтение"]);
    });

    it("refuses a subject over 512 characters and roles over 8192 instead of cutting them", async () => {
        for (const attempt of [() => headersFor("s".repeat(513)), () => headersFor("svc", ["r".repeat(8189)])]) {
            await assert.rejects(attempt, (err: unknown) => {
                assertConnectError(err, Code.InvalidArgument);
                return true;
            });
        }
        assert.strictEqual((await headersFor("s".repeat(512))).get("x-auth-subject")?.length, 512);
        assert.strictEqual((await headersFor("svc", ["r".repeat(8188)])).get("x-auth-roles")?.length, 8192);
    });
});
