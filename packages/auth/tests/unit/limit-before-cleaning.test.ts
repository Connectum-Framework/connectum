/**
 * The size limit applies to the text as it arrives, before control characters are removed.
 *
 * Subject, type and name lose their C0 controls and DEL when they are written and read. A value
 * one character over its limit whose extra character is such a control would shrink to the limit
 * and be accepted if the length were checked after the cleaning. Every path refuses it instead:
 * the writer, the client gateway interceptor, `parseAuthHeaders` (raw and decoded) and the gateway
 * reader of the standard names (raw and decoded). A value at the limit, or at the limit including
 * a control that is then removed, is admitted.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { HeaderValueTooLargeError, parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

type Field = "subject" | "name" | "type";

const LIMITS: Record<Field, number> = { subject: 512, name: 256, type: 128 };
const HEADER: Record<Field, string> = { subject: "x-auth-subject", name: "x-auth-name", type: "x-auth-type" };
const CONTROLS = ["\x01", "\x1F", "\x7F"];

/** The text on the wire: raw, or percent-encoded with the marker so the reader has to decode it. */
function wire(text: string, form: "raw" | "decoded"): string {
    return form === "raw" ? text : `utf-8''${encodeURIComponent(text)}`;
}

/** Headers for a reader: the field holds `text` in the given form, the other two fields are plain. */
function headersFor(field: Field, text: string, form: "raw" | "decoded"): Headers {
    const headers = new Headers({ "x-auth-subject": "s", "x-auth-name": "n", "x-auth-type": "t" });
    headers.set(HEADER[field], wire(text, form));
    if (form === "decoded") headers.set("x-auth-encoding", "percent-utf8");
    return headers;
}

/** Runs the gateway reader of the standard names over the headers; resolves to the identity the handler saw. */
async function viaGateway(headers: Headers): Promise<AuthContext | undefined> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: { subject: "x-auth-subject", name: "x-auth-name", type: "x-auth-type" },
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

for (const field of ["subject", "name", "type"] as const) {
    const limit = LIMITS[field];
    for (const control of CONTROLS) {
        const code = `U+${control.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
        const tooLong = `${"a".repeat(limit)}${control}`;
        const atLimit = `${"a".repeat(limit - 1)}${control}`;
        for (const form of ["raw", "decoded"] as const) {
            describe(`${field} of ${limit + 1} characters, the extra one ${code}, ${form}`, () => {
                it("parseAuthHeaders refuses it", () => {
                    assert.throws(
                        () => parseAuthHeaders(headersFor(field, tooLong, form)),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                            return true;
                        },
                    );
                });

                it("the gateway reader refuses it", async () => {
                    await assert.rejects(
                        () => viaGateway(headersFor(field, tooLong, form)),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                            return true;
                        },
                    );
                });

                it("a value of exactly the limit that holds the control is admitted, cleaned", async () => {
                    assert.strictEqual(parseAuthHeaders(headersFor(field, atLimit, form))?.[field], "a".repeat(limit - 1));
                    assert.strictEqual((await viaGateway(headersFor(field, atLimit, form)))?.[field], "a".repeat(limit - 1));
                });
            });
        }

        describe(`${field} of ${limit + 1} characters, the extra one ${code}, writers`, () => {
            it("setAuthHeaders refuses it and sets no header", () => {
                const headers = new Headers();
                const context: AuthContext = { subject: "s", name: "n", type: "t", roles: [], scopes: [], claims: {}, [field]: tooLong };
                assert.throws(() => setAuthHeaders(headers, context), (err: unknown) => err instanceof HeaderValueTooLargeError && err.field === field);
                assert.deepStrictEqual([...headers.keys()], []);
            });

            it("setAuthHeaders admits a value of exactly the limit that holds the control, cleaned", () => {
                const headers = new Headers();
                setAuthHeaders(headers, { subject: "s", name: "n", type: "t", roles: [], scopes: [], claims: {}, [field]: atLimit });
                assert.strictEqual(parseAuthHeaders(headers)?.[field], "a".repeat(limit - 1));
            });
        });
    }
}

describe("createClientGatewayInterceptor", () => {
    for (const control of CONTROLS) {
        it(`refuses a subject of 513 characters whose extra one is ${JSON.stringify(control)}, and admits 512 that holds it`, async () => {
            const send = async (subject: string): Promise<Headers> => {
                const req = createMockRequest({ service: "t.v1.S", method: "M" });
                await createClientGatewayInterceptor({ secret: "s", subject })((async () => ({ message: {} })) as never)(req);
                return req.header;
            };

            // Refused when the interceptor is created, on the original text, as the writer would.
            await assert.rejects(
                () => send(`${"a".repeat(512)}${control}`),
                (err: unknown) => err instanceof RangeError && /subject/.test(err.message),
            );
            assert.strictEqual((await send(`${"a".repeat(511)}${control}`)).get("x-auth-subject"), "a".repeat(511));
        });
    }
});
