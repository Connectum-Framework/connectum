/**
 * Size of the identity texts the gateway interceptor reads from its mapped headers.
 *
 * The standard `x-auth-*` names carry the Connectum header format, whose limits (subject 512
 * characters, type 128, name 256, roles and scopes 8192 in total) `parseAuthHeaders` already holds
 * a reader to. The gateway reader of those names must do the same at the point where the headers
 * become an `AuthContext`, whether or not the identity is propagated afterwards: an oversize value
 * is refused with `Unauthenticated`, never handed to the handler. A header the gateway maps under
 * a custom name is not in that format; its documented contract is "taken as sent" (the writer
 * refuses an oversize identity when it propagates), and the rows for it pin that.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";

type Field = "subject" | "name" | "type" | "roles" | "scopes";

const LIMITS: Record<Field, number> = { subject: 512, name: 256, type: 128, roles: 8192, scopes: 8192 };

const STANDARD = { subject: "x-auth-subject", name: "x-auth-name", type: "x-auth-type", roles: "x-auth-roles", scopes: "x-auth-scopes" } as const;
const CUSTOM = { subject: "x-user-id", name: "x-user-name", type: "x-user-type", roles: "x-user-roles", scopes: "x-user-scopes" } as const;

/** A header value of exactly `length` characters that is valid for the field (a JSON array for roles). */
function valueOfLength(field: Field, length: number): string {
    if (field === "roles") return JSON.stringify(["r".repeat(length - 4)]);
    return "a".repeat(length);
}

/** Runs the gateway on a request whose `field` header holds `value`; resolves to the identity the handler saw. */
async function run(mapping: Record<Field, string>, field: Field, value: string, propagateHeaders: boolean): Promise<AuthContext | undefined> {
    const interceptor = createGatewayAuthInterceptor({
        headerMapping: mapping,
        trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
        propagateHeaders,
    });
    const req = createMockRequest({ service: "t.v1.S", method: "M" });
    req.header.set("x-gateway-secret", "s");
    req.header.set(mapping.subject, "u");
    req.header.set(mapping[field], value);
    let seen: AuthContext | undefined;
    await interceptor((async () => {
        seen = getAuthContext();
        return { message: {} };
    }) as never)(req);
    return seen;
}

describe("gateway reader of the standard x-auth-* names: size limits", () => {
    for (const field of Object.keys(LIMITS) as Field[]) {
        const limit = LIMITS[field];
        for (const propagateHeaders of [false, true]) {
            it(`${field} of ${limit} characters is admitted (propagateHeaders: ${propagateHeaders})`, async () => {
                const seen = await run(STANDARD, field, valueOfLength(field, limit), propagateHeaders);
                assert.ok(seen, "the handler ran");
            });

            it(`${field} of ${limit + 1} characters is refused with Unauthenticated, the handler does not run (propagateHeaders: ${propagateHeaders})`, async () => {
                let ran = false;
                const interceptor = createGatewayAuthInterceptor({
                    headerMapping: STANDARD,
                    trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
                    propagateHeaders,
                });
                const req = createMockRequest({ service: "t.v1.S", method: "M" });
                req.header.set("x-gateway-secret", "s");
                req.header.set("x-auth-subject", "u");
                req.header.set(STANDARD[field], valueOfLength(field, limit + 1));

                await assert.rejects(
                    () =>
                        interceptor((async () => {
                            ran = true;
                            return { message: {} };
                        }) as never)(req),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                );
                assert.strictEqual(ran, false);
            });
        }
    }

    it("counts a decoded text, not its encoded form", async () => {
        const interceptor = createGatewayAuthInterceptor({
            headerMapping: STANDARD,
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
        });
        for (const [length, admitted] of [[512, true], [513, false]] as const) {
            const req = createMockRequest({ service: "t.v1.S", method: "M" });
            req.header.set("x-gateway-secret", "s");
            req.header.set("x-auth-encoding", "percent-utf8");
            req.header.set("x-auth-subject", `utf-8''${encodeURIComponent("Я".repeat(length))}`);
            const outcome = interceptor((async () => ({ message: {} })) as never)(req);
            if (admitted) await outcome;
            else await assert.rejects(outcome);
        }
    });
});

describe("gateway reader of custom mapped headers: taken as sent", () => {
    for (const field of ["subject", "name", "type", "roles", "scopes"] as const) {
        it(`an oversize ${field} reaches the handler when the identity is not propagated`, async () => {
            const seen = await run(CUSTOM, field, valueOfLength(field, LIMITS[field] + 1), false);
            assert.ok(seen, "the handler ran");
        });

        it(`an oversize ${field} is refused by the writer when the identity is propagated`, async () => {
            await assert.rejects(
                () => run(CUSTOM, field, valueOfLength(field, LIMITS[field] + 1), true),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                    return true;
                },
            );
        });
    }
});
