/**
 * Unit tests for auth header propagation utilities
 *
 * Tests setAuthHeaders() and parseAuthHeaders() for correct
 * serialization/deserialization of AuthContext to/from HTTP headers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

describe("headers", () => {
    describe("setAuthHeaders()", () => {
        it("should set all headers correctly", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                name: "User One",
                roles: ["admin", "editor"],
                scopes: ["read", "write", "delete"],
                claims: { tenant: "acme" },
                type: "jwt",
            };

            setAuthHeaders(headers, context);

            // Header names and value formats are the documented propagation contract
            // (the guide lists them literally), so they are spelled out here rather than
            // taken from the constant the implementation uses.
            assert.strictEqual(headers.get("x-auth-subject"), "user-1");
            assert.strictEqual(headers.get("x-auth-type"), "jwt");
            assert.strictEqual(headers.get("x-auth-name"), "User One");
            assert.strictEqual(headers.get("x-auth-roles"), '["admin","editor"]');
            assert.strictEqual(headers.get("x-auth-scopes"), "read write delete");
            assert.strictEqual(headers.get("x-auth-claims"), '{"tenant":"acme"}');
        });

        it("should skip empty roles and scopes", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-2",
                roles: [],
                scopes: [],
                claims: {},
                type: "api-key",
            };

            setAuthHeaders(headers, context);

            assert.strictEqual(headers.get(AUTH_HEADERS.SUBJECT), "user-2");
            assert.strictEqual(headers.get(AUTH_HEADERS.TYPE), "api-key");
            assert.strictEqual(headers.get(AUTH_HEADERS.ROLES), null);
            assert.strictEqual(headers.get(AUTH_HEADERS.SCOPES), null);
            assert.strictEqual(headers.get(AUTH_HEADERS.CLAIMS), null);
        });
    });

    describe("parseAuthHeaders()", () => {
        it("should return undefined when subject missing", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.ROLES, '["admin"]');

            const result = parseAuthHeaders(headers);
            assert.strictEqual(result, undefined);
        });

        it("should parse all headers correctly", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.ROLES, '["admin","editor"]');
            headers.set(AUTH_HEADERS.SCOPES, "read write");
            headers.set(AUTH_HEADERS.CLAIMS, '{"tenant":"acme"}');

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject, "user-1");
            assert.strictEqual(result.type, "jwt");
            assert.deepStrictEqual(result.roles, ["admin", "editor"]);
            assert.deepStrictEqual(result.scopes, ["read", "write"]);
            assert.deepStrictEqual(result.claims, { tenant: "acme" });
        });

        it("should handle malformed JSON gracefully", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.ROLES, "not-valid-json");
            headers.set(AUTH_HEADERS.CLAIMS, "{broken");

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject, "user-1");
            assert.deepStrictEqual(result.roles, []);
            assert.deepStrictEqual(result.claims, {});
        });

        it("should default type to 'unknown' when missing", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.type, "unknown");
        });

        // Решение Connectum, документированного источника нет: guide/auth/context.md
        // перечисляет заголовки x-auth-*, но не называет предел длины. Выбрано:
        // subject режется до 512 символов, а не отклоняется. Побочное следствие
        // политики: два subject с общим префиксом в 512 знаков после усечения
        // неразличимы.
        it("should truncate subject exceeding 512 characters", () => {
            const headers = new Headers();
            const longSubject = "a".repeat(600);
            headers.set(AUTH_HEADERS.SUBJECT, longSubject);

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject.length, 512);
            assert.strictEqual(result.subject, "a".repeat(512));
        });

        // Нижняя половина пары: значение ровно на пределе (решение Connectum, см. выше)
        // проходит без изменений, значит усечение начинается именно с 513-го знака.
        it("should not truncate subject within 512 character limit", () => {
            const headers = new Headers();
            const subject = "a".repeat(512);
            headers.set(AUTH_HEADERS.SUBJECT, subject);

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject.length, 512);
        });

        // Решение Connectum, документированного источника нет: тип аутентификации
        // x-auth-type режется до 128 знаков, а не отклоняется.
        it("should truncate type exceeding 128 characters", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            const longType = "t".repeat(200);
            headers.set(AUTH_HEADERS.TYPE, longType);

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.type.length, 128);
            assert.strictEqual(result.type, "t".repeat(128));
        });

        // Guide (context.md, "Propagated Headers"): x-auth-roles, x-auth-scopes and
        // x-auth-claims have a limit of 8192 characters for the serialized value; a value
        // over the limit is not truncated, the receiver ignores it and uses an empty value.
        // Each value below is built to be exactly 8192 characters (accepted) and exactly
        // 8193 characters (ignored), so a limit moved by even one character is caught.
        // The limit is in characters, not bytes: the multi-byte filler is 2 bytes per
        // character in UTF-8, so a byte-based limit would reject the accepted value.
        for (const { filler, label } of [
            { filler: "x", label: "ASCII" },
            { filler: "é", label: "multi-byte" },
        ]) {
            const claimsOfLength = (length: number): string => {
                // {"d":"<filler*n>"} adds 8 characters around the filler
                const json = JSON.stringify({ d: filler.repeat(length - 8) });
                assert.strictEqual(json.length, length);
                return json;
            };
            const rolesOfLength = (length: number): string => {
                // ["<filler*n>"] adds 4 characters around the filler
                const json = JSON.stringify([filler.repeat(length - 4)]);
                assert.strictEqual(json.length, length);
                return json;
            };

            it(`should accept claims of exactly 8192 characters and ignore 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.CLAIMS, claimsOfLength(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.claims, { d: filler.repeat(8184) });

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.CLAIMS, claimsOfLength(8193));
                const result = parseAuthHeaders(overLimit);
                assert.ok(result, "an oversized claims header must not reject the request");
                assert.deepStrictEqual(result.claims, {});
                assert.strictEqual(result.subject, "user-1");
            });

            it(`should accept roles of exactly 8192 characters and ignore 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.ROLES, rolesOfLength(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.roles, [filler.repeat(8188)]);

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.ROLES, rolesOfLength(8193));
                const result = parseAuthHeaders(overLimit);
                assert.ok(result, "an oversized roles header must not reject the request");
                assert.deepStrictEqual(result.roles, []);
            });

            it(`should accept scopes of exactly 8192 characters and ignore 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.SCOPES, filler.repeat(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.scopes, [filler.repeat(8192)]);

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.SCOPES, filler.repeat(8193));
                const result = parseAuthHeaders(overLimit);
                assert.ok(result, "an oversized scopes header must not reject the request");
                assert.deepStrictEqual(result.scopes, []);
            });
        }

        it("should parse ordinary claims well within the limit", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.CLAIMS, JSON.stringify({ data: "x".repeat(100) }));

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.deepStrictEqual(result.claims, { data: "x".repeat(100) });
        });
    });

    describe("name propagation", () => {
        it("should set and parse name header", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                name: "John Doe",
                roles: [],
                scopes: [],
                claims: {},
                type: "jwt",
            };

            setAuthHeaders(headers, context);
            assert.strictEqual(headers.get(AUTH_HEADERS.NAME), "John Doe");

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.strictEqual(parsed.name, "John Doe");
        });

        it("should not set name header when name is undefined", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: {},
                type: "jwt",
            };

            setAuthHeaders(headers, context);
            assert.strictEqual(headers.get(AUTH_HEADERS.NAME), null);
        });

        // Решение Connectum, документированного источника нет: отображаемое имя
        // режется до 256 знаков при записи в x-auth-name, а не отклоняется.
        it("should truncate name exceeding 256 characters", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                name: "n".repeat(300),
                roles: [],
                scopes: [],
                claims: {},
                type: "jwt",
            };

            setAuthHeaders(headers, context);
            assert.strictEqual(headers.get(AUTH_HEADERS.NAME)!.length, 256);
        });
    });

    // Guide (context.md, "Propagated Headers"): control characters are removed from the
    // subject, type and name when written and when read, except tab; NUL, CR and LF are
    // not removed but refused on write (see the next block).
    describe("sanitized output", () => {
        const emptyContext = { roles: [], scopes: [], claims: {}, type: "jwt" } as const;

        it("should remove control characters from subject, type and name on write", () => {
            const headers = new Headers();

            setAuthHeaders(headers, {
                ...emptyContext,
                subject: "user\x01-\x1F-\x7F-clean",
                name: "Jo\x01hn\x08 Doe",
                type: "jwt\x07-type",
            });

            assert.strictEqual(headers.get("x-auth-subject"), "user---clean");
            assert.strictEqual(headers.get("x-auth-type"), "jwt-type");
            assert.strictEqual(headers.get("x-auth-name"), "John Doe");
        });

        it("should remove control characters from subject, type and name on read", () => {
            // Headers.set rejects NUL, CR and LF itself, so the read side is exercised
            // with the control characters a Headers object does accept.
            const headers = new Headers();
            headers.set("x-auth-subject", "user\x01-\x1F-\x7F-clean");
            headers.set("x-auth-type", "jwt\x07-type");
            headers.set("x-auth-name", "Jo\x08hn");

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject, "user---clean");
            assert.strictEqual(result.type, "jwt-type");
            assert.strictEqual(result.name, "John");
        });

        it("should keep a horizontal tab inside a value", () => {
            const headers = new Headers();

            setAuthHeaders(headers, { ...emptyContext, subject: "user\tone" });

            assert.strictEqual(headers.get("x-auth-subject"), "user\tone");
            assert.strictEqual(parseAuthHeaders(headers)?.subject, "user\tone");
        });

        it("should keep scopes exactly as granted, control characters other than NUL/CR/LF included", () => {
            const headers = new Headers();

            setAuthHeaders(headers, { ...emptyContext, subject: "u", scopes: ["a\tb", "c\x01d"] });

            // A cleaned scope string could match a privilege nobody granted, so nothing is removed.
            assert.strictEqual(headers.get("x-auth-scopes"), "a\tb c\x01d");
        });
    });

    // An identity holding NUL, CR or LF cannot be written into a header. It is refused with a
    // TypeError that names the field and leaves the headers untouched; removing a line break
    // instead would turn two different subjects ("al\nice" and "alice") into one.
    describe("identity fields that cannot be a header value", () => {
        const base = { subject: "user", name: "Name", roles: ["r"], scopes: ["s"], claims: { k: "v" }, type: "jwt" } as const;

        const cases: Array<[string, string, Partial<AuthContext>]> = [
            ["subject with LF", "subject", { subject: "al\nice" }],
            ["subject with CR", "subject", { subject: "al\rice" }],
            ["subject with NUL", "subject", { subject: "al\0ice" }],
            ["subject with a header-injection attempt", "subject", { subject: 'mallory\r\nx-auth-roles: ["admin"]' }],
            ["type with LF", "type", { type: "j\nwt" }],
            ["type with NUL", "type", { type: "j\0wt" }],
            ["name with CR", "name", { name: "a\rb" }],
            ["name with LF", "name", { name: "a\nb" }],
            ["a scope with LF", "scopes", { scopes: ["ok", "re\nad"] }],
            ["a scope with CR", "scopes", { scopes: ["re\rad"] }],
            ["a scope with NUL", "scopes", { scopes: ["re\0ad"] }],
        ];

        for (const [label, field, override] of cases) {
            it(`should throw a TypeError naming ${field} for ${label} and set no header`, () => {
                const headers = new Headers();

                assert.throws(
                    () => setAuthHeaders(headers, { ...base, ...override }),
                    (err: unknown) => {
                        assert.ok(err instanceof TypeError);
                        assert.ok(err.message.includes(`AuthContext.${field}`), err.message);
                        assert.ok(err.message.includes("NUL, CR or LF"), err.message);
                        return true;
                    },
                );

                assert.deepStrictEqual([...headers.keys()], [], "validation happens before any header is written");
            });
        }

        it("should still write an identity without NUL, CR or LF", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, name: "Jo Doe\tJr" });
            assert.strictEqual(headers.get("x-auth-subject"), "user");
            assert.strictEqual(headers.get("x-auth-name"), "Jo Doe\tJr");
        });

        it("should not look at claims or roles, which are JSON-encoded and cannot contain a raw line break", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, roles: ["a\nb"], claims: { note: "x\ny" } });
            assert.strictEqual(headers.get("x-auth-roles"), '["a\\nb"]');
            assert.strictEqual(headers.get("x-auth-claims"), '{"note":"x\\ny"}');
        });
    });

    // Same limit as on the read side: a serialized value over 8192 characters is left
    // out entirely (never truncated), while the other headers are still written.
    describe("size limit on write", () => {
        const base = { subject: "user-1", type: "jwt" } as const;

        it("should write roles of exactly 8192 characters and omit 8193", () => {
            const atLimit = new Headers();
            setAuthHeaders(atLimit, { ...base, roles: ["r".repeat(8188)], scopes: [], claims: {} });
            assert.strictEqual(atLimit.get("x-auth-roles")?.length, 8192);

            const overLimit = new Headers();
            setAuthHeaders(overLimit, { ...base, roles: ["r".repeat(8189)], scopes: [], claims: {} });
            assert.strictEqual(overLimit.get("x-auth-roles"), null);
            assert.strictEqual(overLimit.get("x-auth-subject"), "user-1");
        });

        it("should write scopes of exactly 8192 characters and omit 8193", () => {
            const atLimit = new Headers();
            setAuthHeaders(atLimit, { ...base, roles: [], scopes: ["s".repeat(8192)], claims: {} });
            assert.strictEqual(atLimit.get("x-auth-scopes")?.length, 8192);

            const overLimit = new Headers();
            setAuthHeaders(overLimit, { ...base, roles: [], scopes: ["s".repeat(8193)], claims: {} });
            assert.strictEqual(overLimit.get("x-auth-scopes"), null);
            assert.strictEqual(overLimit.get("x-auth-subject"), "user-1");
        });

        it("should write claims of exactly 8192 characters and omit 8193", () => {
            const atLimit = new Headers();
            setAuthHeaders(atLimit, { ...base, roles: [], scopes: [], claims: { d: "c".repeat(8184) } });
            assert.strictEqual(atLimit.get("x-auth-claims")?.length, 8192);

            const overLimit = new Headers();
            setAuthHeaders(overLimit, { ...base, roles: [], scopes: [], claims: { d: "c".repeat(8185) } });
            assert.strictEqual(overLimit.get("x-auth-claims"), null);
            assert.strictEqual(overLimit.get("x-auth-subject"), "user-1");
        });

        it("should measure the limit in characters, not bytes", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, roles: [], scopes: [], claims: { d: "é".repeat(8184) } });
            assert.strictEqual(headers.get("x-auth-claims")?.length, 8192);
        });
    });

    describe("propagatedClaims filter", () => {
        it("should only propagate listed claims", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: { tenant: "acme", secret: "password", level: 5 },
                type: "jwt",
            };

            setAuthHeaders(headers, context, ["tenant", "level"]);

            const claimsRaw = headers.get(AUTH_HEADERS.CLAIMS);
            assert.ok(claimsRaw);
            const parsed = JSON.parse(claimsRaw);
            assert.deepStrictEqual(parsed, { tenant: "acme", level: 5 });
        });

        it("should propagate all claims when propagatedClaims is undefined", () => {
            const headers = new Headers();
            const context: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: { a: 1, b: 2 },
                type: "jwt",
            };

            setAuthHeaders(headers, context);

            const claimsRaw = headers.get(AUTH_HEADERS.CLAIMS);
            assert.ok(claimsRaw);
            assert.deepStrictEqual(JSON.parse(claimsRaw), { a: 1, b: 2 });
        });
    });

    describe("round-trip", () => {
        it("should preserve context through setAuthHeaders -> parseAuthHeaders", () => {
            const original: AuthContext = {
                subject: "round-trip-user",
                name: "Round Trip",
                roles: ["admin", "user,with,commas", "role with spaces"],
                scopes: ["read", "write", "delete"],
                claims: { org: "test-org", level: 5 },
                type: "jwt",
            };

            const headers = new Headers();
            setAuthHeaders(headers, original);

            // The wire form is fixed independently of the parser: a change applied to the writer and
            // the reader together (another separator, another header name) would still round-trip.
            assert.deepStrictEqual(Object.fromEntries(headers), {
                "x-auth-subject": "round-trip-user",
                "x-auth-type": "jwt",
                "x-auth-name": "Round Trip",
                "x-auth-roles": '["admin","user,with,commas","role with spaces"]',
                "x-auth-scopes": "read write delete",
                "x-auth-claims": '{"org":"test-org","level":5}',
            });

            const restored = parseAuthHeaders(headers);

            assert.ok(restored);
            assert.strictEqual(restored.name, original.name);
            assert.strictEqual(restored.subject, original.subject);
            assert.strictEqual(restored.type, original.type);
            assert.deepStrictEqual(restored.roles, original.roles);
            assert.deepStrictEqual(restored.scopes, original.scopes);
            assert.deepStrictEqual(restored.claims, original.claims);
        });
    });
});
