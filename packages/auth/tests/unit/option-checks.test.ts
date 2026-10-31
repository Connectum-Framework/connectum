/**
 * Creation-time checks of the string options whose value is later written into a header, read as a
 * header name or used as part of the identity.
 *
 * A header name must be an HTTP token (otherwise every request fails inside `Headers`, as an
 * internal error). A gateway `defaultType` that cannot be propagated (empty, over 128 characters,
 * a lone surrogate) fails only when a request arrives; with `propagateHeaders` on it is refused
 * when the interceptor is created, naming the option. With `propagateHeaders` off nothing changes.
 * The client gateway interceptor checks its secret and subject when it is created, and the writer
 * refuses an empty subject or type because the reader would not read them back.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { setAuthHeaders, UnsafeHeaderValueError } from "../../src/headers.ts";
import { meshIdentityTrust, sharedSecretTrust, signedTokenTrust } from "../../src/internal-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

const BAD_NAMES = ["", "bad name", "x:y", "x\ny", "x-ü", "a,b", "(x)"];

/** Gateway options with one field replaced. */
function gateway(overrides: Record<string, unknown>) {
    return () =>
        createGatewayAuthInterceptor({
            headerMapping: { subject: "x-user-id" },
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
            ...overrides,
        } as never);
}

describe("header name options", () => {
    for (const name of BAD_NAMES) {
        const label = JSON.stringify(name);
        it(`gateway headerMapping.subject ${label} is refused`, () => {
            assert.throws(gateway({ headerMapping: { subject: name } }), /headerMapping/);
        });
        for (const field of ["name", "roles", "scopes", "type", "claims"]) {
            if (name === "") continue; // an empty optional mapping means "not mapped"
            it(`gateway headerMapping.${field} ${label} is refused`, () => {
                assert.throws(gateway({ headerMapping: { subject: "x-user-id", [field]: name } }), new RegExp(`headerMapping\\.${field}`));
            });
        }
        it(`gateway trustSource.header ${label} is refused`, () => {
            assert.throws(gateway({ trustSource: { header: name, expectedValues: ["s"] } }), /trustSource\.header/);
        });
        it(`gateway stripHeaders entry ${label} is refused`, () => {
            assert.throws(gateway({ stripHeaders: [name] }), /stripHeaders/);
        });
        it(`internal trust sources refuse the header ${label}`, () => {
            assert.throws(() => sharedSecretTrust({ secret: "s", header: name }), /header/);
            assert.throws(() => meshIdentityTrust({ allowlist: [{ principal: "p", roles: [] }], header: name }), /header/);
            assert.throws(() => signedTokenTrust({ issuers: { i: { secret: "0123456789abcdef0123456789abcdef" } }, header: name } as never), /header/);
        });
    }

    it("valid names are accepted", () => {
        assert.doesNotThrow(gateway({ headerMapping: { subject: "X-User_Id.1", roles: "x-roles" }, stripHeaders: ["x-extra"] }));
    });
});

describe("gateway defaultType", () => {
    const UNPROPAGATABLE: Array<[string, string]> = [
        ["an empty text", ""],
        ["a text over 128 characters", "t".repeat(129)],
        ["a lone high surrogate", "a\uD800"],
        ["a lone low surrogate", "\uDC00b"],
    ];

    for (const [label, defaultType] of UNPROPAGATABLE) {
        it(`${label} is refused when headers are propagated, naming defaultType`, () => {
            assert.throws(gateway({ defaultType, propagateHeaders: true }), /defaultType/);
        });

        it(`${label} is still accepted when headers are not propagated`, () => {
            assert.doesNotThrow(gateway({ defaultType }));
            assert.doesNotThrow(gateway({ defaultType, propagateHeaders: false }));
        });
    }

    it("a text of exactly 128 characters, a non-Latin text and a surrogate pair are accepted when propagating", () => {
        assert.doesNotThrow(gateway({ defaultType: "t".repeat(128), propagateHeaders: true }));
        assert.doesNotThrow(gateway({ defaultType: "шлюз", propagateHeaders: true }));
        assert.doesNotThrow(gateway({ defaultType: "gate-\u{1F600}", propagateHeaders: true }));
    });
});

describe("createClientGatewayInterceptor options", () => {
    const make = (options: Record<string, unknown>) => () => createClientGatewayInterceptor({ secret: "s", subject: "svc", ...options } as never);

    for (const [label, secret] of [["an empty secret", ""], ["a secret with a line break", "a\nb"], ["a secret with a leading space", " s"], ["a secret with a trailing tab", "s\t"], ["a secret above U+00FF", "секрет"], ["a non-string secret", 5]] as const) {
        it(`${label} is refused, naming secret`, () => {
            assert.throws(make({ secret }), /secret/);
        });
    }

    for (const [label, subject] of [["an empty subject", ""], ["a subject with a line break", "a\nb"], ["a subject with a lone surrogate", "a\uD800"], ["a non-string subject", 5]] as const) {
        it(`${label} is refused, naming subject`, () => {
            assert.throws(make({ subject }), /subject/);
        });
    }

    it("roles that are not a list of strings are refused, naming roles", () => {
        assert.throws(make({ roles: "admin" }), /roles/);
        assert.throws(make({ roles: ["a", 1] }), /roles/);
        // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
        assert.throws(make({ roles: ["a", , "b"] }), /roles/);
    });

    it("valid options, including a non-Latin subject, are accepted", () => {
        assert.doesNotThrow(make({ subject: "сервис", roles: ["a", "b"] }));
    });
});

describe("the writer and an empty subject or type", () => {
    for (const field of ["subject", "type"] as const) {
        it(`setAuthHeaders refuses an empty ${field}, which the reader could not read back`, () => {
            const out = new Headers();
            assert.throws(
                () => setAuthHeaders(out, { ...createMockAuthContext(), [field]: "" }),
                (err: unknown) => err instanceof UnsafeHeaderValueError && err.field === field && /must not be empty/.test(err.message),
            );
            assert.deepStrictEqual([...out.keys()], []);
        });
    }
});
