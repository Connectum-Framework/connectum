/**
 * Spaces and tabs at the edge of an identity text survive the header round trip.
 *
 * `Headers.set` removes leading and trailing HTTP whitespace (space and horizontal tab) from every
 * value, so a subject ` alice` would arrive as `alice`, merging two identities, and a name
 * `Alice ` would lose its space. Such texts are written as `utf-8''` plus percent-encoding (which
 * has no edge whitespace) and read back identical; whitespace inside a text needs nothing.
 * Roles and claims are JSON and never start or end with whitespace.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

const base = { roles: [], scopes: [], claims: {}, type: "jwt" } as const;

const EDGE_TEXTS = [" a", "a ", "\ta", "a\t", " a ", "\t a\t ", " ", "\t", "  ", " a b ", " a "];
const INNER_TEXTS = ["a b", "a\tb", "a  b", " a"];

/** An identity that holds `text` in one field; for a scope the text is the first of two scopes. */
function contextWith(field: "subject" | "name" | "type" | "scope", text: string): AuthContext {
    return {
        ...base,
        subject: field === "subject" ? text : "s",
        ...(field === "name" ? { name: text } : {}),
        type: field === "type" ? text : "jwt",
        scopes: field === "scope" ? [text, "read"] : [],
    };
}

/** The same field of a parsed identity. */
function fieldOf(parsed: AuthContext | undefined, field: "subject" | "name" | "type" | "scope"): string | undefined {
    return field === "scope" ? parsed?.scopes[0] : parsed?.[field];
}

describe("edge whitespace in identity texts", () => {
    for (const field of ["subject", "name", "type", "scope"] as const) {
        for (const text of EDGE_TEXTS) {
            // A scope may not hold a space, so only the tab and no-break-space forms apply to it.
            if (field === "scope" && text.includes(" ")) continue;
            it(`${field} ${JSON.stringify(text)} round-trips through Headers unchanged`, () => {
                const headers = new Headers();
                setAuthHeaders(headers, contextWith(field, text));

                assert.strictEqual(fieldOf(parseAuthHeaders(headers), field), text);
                for (const [, value] of headers) {
                    assert.strictEqual(value, value.replace(/^[ \t]+|[ \t]+$/g, ""), "no header value starts or ends with whitespace");
                }
            });
        }

        for (const text of INNER_TEXTS) {
            if (field === "scope" && text.includes(" ")) continue;
            it(`${field} ${JSON.stringify(text)} with whitespace only inside is written as is`, () => {
                const headers = new Headers();
                setAuthHeaders(headers, contextWith(field, text));

                assert.strictEqual(fieldOf(parseAuthHeaders(headers), field), text);
                assert.strictEqual(headers.get("x-auth-encoding"), null, "nothing was encoded");
            });
        }
    }

    it("keeps ` alice` and `alice` apart", () => {
        const a = new Headers();
        const b = new Headers();
        setAuthHeaders(a, { ...base, subject: " alice" });
        setAuthHeaders(b, { ...base, subject: "alice" });

        assert.notStrictEqual(a.get("x-auth-subject"), b.get("x-auth-subject"));
        assert.strictEqual(parseAuthHeaders(a)?.subject, " alice");
        assert.strictEqual(parseAuthHeaders(b)?.subject, "alice");
        assert.strictEqual(b.get("x-auth-encoding"), null, "a plain value needs no marker");
    });

    it("declares the encoding when an edge text was encoded", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "alice ", name: "Bob" });

        assert.strictEqual(headers.get("x-auth-encoding"), "percent-utf8");
        assert.strictEqual(headers.get("x-auth-subject"), "utf-8''alice%20");
        assert.strictEqual(headers.get("x-auth-name"), "Bob");
    });

    it("keeps the first scope's leading tab and the last scope's trailing tab", () => {
        const headers = new Headers();
        setAuthHeaders(headers, { ...base, subject: "s", scopes: ["\tfirst", "middle", "last\t"] });

        assert.deepStrictEqual(parseAuthHeaders(headers)?.scopes, ["\tfirst", "middle", "last\t"]);
    });

    it("roles and claims never start or end with whitespace, whatever they hold", () => {
        const headers = new Headers();
        const roles = [" a", "b ", "\tc\t", " "];
        const claims = { " k ": " v ", "\t": "\t" };
        setAuthHeaders(headers, { ...base, subject: "s", roles, claims });

        const parsed = parseAuthHeaders(headers);
        assert.deepStrictEqual(parsed?.roles, roles);
        assert.deepStrictEqual(parsed?.claims, claims);
    });

    it("propagates a gateway defaultType with edge whitespace unchanged", async () => {
        const interceptor = createGatewayAuthInterceptor({
            headerMapping: { subject: "x-user-id" },
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
            defaultType: " gate ",
            propagateHeaders: true,
        });
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        req.header.set("x-gateway-secret", "s");
        req.header.set("x-user-id", "u");
        let seen: string | undefined;

        await interceptor((async () => {
            seen = getAuthContext()?.type;
            return { message: {} };
        }) as never)(req);

        assert.strictEqual(seen, " gate ");
        assert.strictEqual(parseAuthHeaders(req.header)?.type, " gate ");
    });

    it("writes a client gateway subject with edge whitespace unchanged", async () => {
        const req = createMockRequest({ service: "t.v1.S", method: "M" });
        await createClientGatewayInterceptor({ secret: "s", subject: " svc " })((async () => ({ message: {} })) as never)(req);

        assert.strictEqual(parseAuthHeaders(req.header)?.subject, " svc ");
    });
});
