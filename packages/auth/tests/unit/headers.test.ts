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

        // Guide (context.md, "Propagated Headers", Limits and sizes): x-auth-subject is cut to 512
        // characters, truncated and not rejected. A side effect the guide names: two subjects that
        // share their first 512 characters become indistinguishable downstream.
        it("should truncate subject exceeding 512 characters", () => {
            const headers = new Headers();
            const longSubject = "a".repeat(600);
            headers.set(AUTH_HEADERS.SUBJECT, longSubject);

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject.length, 512);
            assert.strictEqual(result.subject, "a".repeat(512));
        });

        // Lower half of the pair: a value exactly at the documented limit passes unchanged, so the
        // cut starts at the 513th character.
        it("should not truncate subject within 512 character limit", () => {
            const headers = new Headers();
            const subject = "a".repeat(512);
            headers.set(AUTH_HEADERS.SUBJECT, subject);

            const result = parseAuthHeaders(headers);

            assert.ok(result);
            assert.strictEqual(result.subject.length, 512);
        });

        // Guide (context.md, Limits and sizes): x-auth-type is cut to 128 characters, not rejected.
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

        // Guide (context.md, Limits and sizes): x-auth-name is cut to 256 characters, not rejected.
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

    // Guide (context.md, Limits and sizes): x-auth-subject is cut to 512 characters,
    // x-auth-type to 128 and x-auth-name to 256, when written and when read. A cut value keeps
    // its first characters. One character under, at and one over each limit separates a limit
    // that is moved by one in either direction, and the letters cycle so a cut from the wrong end
    // gives a different string.
    describe("length limits of subject, type and name", () => {
        const fields = [
            { field: "subject", header: "x-auth-subject", limit: 512 },
            { field: "type", header: "x-auth-type", limit: 128 },
            { field: "name", header: "x-auth-name", limit: 256 },
        ] as const;
        const textOfLength = (length: number): string => Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

        for (const { field, header, limit } of fields) {
            for (const length of [limit - 1, limit, limit + 1]) {
                const value = textOfLength(length);
                const expected = value.slice(0, limit);

                it(`should write a ${field} of ${length} characters as ${expected.length} characters`, () => {
                    const headers = new Headers();
                    setAuthHeaders(headers, { subject: "s", type: "t", name: "n", roles: [], scopes: [], claims: {}, [field]: value });

                    assert.strictEqual(headers.get(header), expected);
                });

                it(`should read a ${field} of ${length} characters as ${expected.length} characters`, () => {
                    const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": "t", "x-auth-name": "n" });
                    headers.set(header, value);

                    assert.strictEqual(parseAuthHeaders(headers)?.[field], expected);
                });
            }
        }
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
            // A header value is a byte string: the platform refuses a character above U+00FF.
            ["a Cyrillic subject", "subject", { subject: "Иван" }],
            ["a subject with an emoji", "subject", { subject: "user-\u{1F600}" }],
            ["a type above U+00FF", "type", { type: "тип" }],
            ["a name with a line separator", "name", { name: "a b" }],
            ["a scope above U+00FF", "scopes", { scopes: ["ok", "чтение"] }],
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

        it("should still write Latin-1 text, which is a valid byte string", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, subject: "café", name: "Zoë", scopes: ["lecture-é"] });
            assert.strictEqual(headers.get("x-auth-subject"), "café");
            assert.strictEqual(headers.get("x-auth-name"), "Zoë");
            assert.strictEqual(headers.get("x-auth-scopes"), "lecture-é");
        });

        it("should write roles and claims above U+00FF as JSON escapes and give them back unchanged", () => {
            const headers = new Headers();
            const roles = ["админ", "o\u{1F600}"];
            const claims = { city: "Москва", note: "ok" };
            setAuthHeaders(headers, { ...base, roles, claims });

            // The wire value is plain ASCII/Latin-1 JSON ...
            assert.ok(/^[\x00-\xFF]*$/.test(headers.get("x-auth-roles") ?? ""), "roles header holds bytes only");
            assert.ok(/^[\x00-\xFF]*$/.test(headers.get("x-auth-claims") ?? ""), "claims header holds bytes only");
            // ... and the reader restores the original values.
            const parsed = parseAuthHeaders(headers);
            assert.deepStrictEqual(parsed?.roles, roles);
            assert.deepStrictEqual(parsed?.claims, claims);
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
