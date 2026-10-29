/**
 * Unit tests for auth header propagation utilities
 *
 * Tests setAuthHeaders() and parseAuthHeaders() for correct
 * serialization/deserialization of AuthContext to/from HTTP headers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
import { HeaderValueTooLargeError, parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
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

        // A value over its limit is refused on read, never cut: two subjects that share their
        // first 512 characters would otherwise become one identity downstream.
        it("should refuse a subject exceeding 512 characters as Unauthenticated", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "a".repeat(513));

            assert.throws(
                () => parseAuthHeaders(headers),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                    return true;
                },
            );
        });

        it("should not refuse a subject of exactly 512 characters", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "a".repeat(512));

            assert.strictEqual(parseAuthHeaders(headers)?.subject, "a".repeat(512));
        });

        it("should refuse a type exceeding 128 characters as Unauthenticated", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "t".repeat(129));

            assert.throws(
                () => parseAuthHeaders(headers),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                    return true;
                },
            );
        });

        // Guide (context.md, "Propagated Headers"): x-auth-roles, x-auth-scopes and
        // x-auth-claims have a limit of 8192 characters for the serialized value; a value
        // over the limit is refused, not ignored: a receiver that read it as empty would stop
        // matching a deny rule on a role or claim. Each value below is built to be exactly 8192
        // characters (accepted) and exactly 8193 characters (refused), so a limit moved by even
        // one character is caught.
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

            it(`should accept claims of exactly 8192 characters and refuse 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.CLAIMS, claimsOfLength(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.claims, { d: filler.repeat(8184) });

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.CLAIMS, claimsOfLength(8193));
                assert.throws(
                    () => parseAuthHeaders(overLimit),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                    "an oversized claims header must be refused, not read as empty",
                );
            });

            it(`should accept roles of exactly 8192 characters and refuse 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.ROLES, rolesOfLength(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.roles, [filler.repeat(8188)]);

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.ROLES, rolesOfLength(8193));
                assert.throws(
                    () => parseAuthHeaders(overLimit),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                    "an oversized roles header must be refused, not read as empty",
                );
            });

            it(`should accept scopes of exactly 8192 characters and refuse 8193 (${label})`, () => {
                const atLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                atLimit.set(AUTH_HEADERS.SCOPES, filler.repeat(8192));
                assert.deepStrictEqual(parseAuthHeaders(atLimit)?.scopes, [filler.repeat(8192)]);

                const overLimit = new Headers([[AUTH_HEADERS.SUBJECT, "user-1"]]);
                overLimit.set(AUTH_HEADERS.SCOPES, filler.repeat(8193));
                assert.throws(
                    () => parseAuthHeaders(overLimit),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                    "an oversized scopes header must be refused, not read as empty",
                );
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

        it("should refuse a name exceeding 256 characters and set no header", () => {
            const headers = new Headers();
            const context: AuthContext = { subject: "user-1", name: "n".repeat(257), roles: [], scopes: [], claims: {}, type: "jwt" };

            assert.throws(
                () => setAuthHeaders(headers, context),
                (err: unknown) => err instanceof HeaderValueTooLargeError && err.field === "name" && err.limit === 256,
            );
            assert.deepStrictEqual([...headers.keys()], []);
        });
    });

    // x-auth-subject holds at most 512 characters, x-auth-type 128 and x-auth-name 256. A longer
    // value is refused when written and when read, never cut: a cut value would make two subjects
    // that share their first characters one identity. One character under, at and one over each
    // limit separates a limit that is moved by one in either direction.
    describe("length limits of subject, type and name", () => {
        const fields = [
            { field: "subject", header: "x-auth-subject", limit: 512 },
            { field: "type", header: "x-auth-type", limit: 128 },
            { field: "name", header: "x-auth-name", limit: 256 },
        ] as const;
        const textOfLength = (length: number): string => Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

        for (const { field, header, limit } of fields) {
            for (const length of [limit - 1, limit]) {
                const value = textOfLength(length);

                it(`should write a ${field} of ${length} characters unchanged`, () => {
                    const headers = new Headers();
                    setAuthHeaders(headers, { subject: "s", type: "t", name: "n", roles: [], scopes: [], claims: {}, [field]: value });

                    assert.strictEqual(headers.get(header), value);
                });

                it(`should read a ${field} of ${length} characters unchanged`, () => {
                    const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": "t", "x-auth-name": "n" });
                    headers.set(header, value);

                    assert.strictEqual(parseAuthHeaders(headers)?.[field], value);
                });
            }

            const tooLong = textOfLength(limit + 1);

            it(`should refuse to write a ${field} of ${limit + 1} characters and set no header`, () => {
                const headers = new Headers();
                assert.throws(
                    () => setAuthHeaders(headers, { subject: "s", type: "t", name: "n", roles: [], scopes: [], claims: {}, [field]: tooLong }),
                    (err: unknown) => err instanceof HeaderValueTooLargeError && err.field === field && err.limit === limit,
                );
                assert.deepStrictEqual([...headers.keys()], []);
            });

            it(`should refuse to read a ${field} of ${limit + 1} characters`, () => {
                const headers = new Headers({ "x-auth-subject": "s", "x-auth-type": "t", "x-auth-name": "n" });
                headers.set(header, tooLong);

                assert.throws(
                    () => parseAuthHeaders(headers),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                        return true;
                    },
                );
            });
        }

        it("should keep two subjects that differ only after the 512th character apart", () => {
            const prefix = "u".repeat(512);
            for (const suffix of ["-A", "-B"]) {
                assert.throws(
                    () => setAuthHeaders(new Headers(), { subject: prefix + suffix, type: "t", roles: [], scopes: [], claims: {} }),
                    HeaderValueTooLargeError,
                );
            }
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
            // Scopes are joined and split on a space: one granted scope with a space would be read back as several.
            ["a scope with a space", "scopes", { scopes: ["reports read admin"] }],
            ["a scope with a leading space", "scopes", { scopes: ["ok", " admin"] }],
            // A lone surrogate has no UTF-8 form, so it cannot be encoded.
            ["a subject with a lone surrogate", "subject", { subject: "a\uD800b" }],
            ["a name with a lone surrogate", "name", { name: "a\uDC00" }],
            ["a type with a lone surrogate", "type", { type: "\uD83D" }],
            ["a scope with a lone surrogate", "scopes", { scopes: ["ok", "re\uD800ad"] }],
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

    // Same limit as on the read side: a serialized value over 8192 characters is refused (never
    // cut, never left out), and nothing is written.
    describe("size limit on write", () => {
        const base = { subject: "user-1", type: "jwt" } as const;

        const cases = [
            { field: "roles", at: { roles: ["r".repeat(8188)], scopes: [], claims: {} }, over: { roles: ["r".repeat(8189)], scopes: [], claims: {} }, header: "x-auth-roles" },
            { field: "scopes", at: { roles: [], scopes: ["s".repeat(8192)], claims: {} }, over: { roles: [], scopes: ["s".repeat(8193)], claims: {} }, header: "x-auth-scopes" },
            { field: "claims", at: { roles: [], scopes: [], claims: { d: "c".repeat(8184) } }, over: { roles: [], scopes: [], claims: { d: "c".repeat(8185) } }, header: "x-auth-claims" },
        ] as const;

        for (const { field, at, over, header } of cases) {
            it(`should write ${field} of exactly 8192 characters and refuse 8193`, () => {
                const atLimit = new Headers();
                setAuthHeaders(atLimit, { ...base, ...at });
                assert.strictEqual(atLimit.get(header)?.length, 8192);

                const overLimit = new Headers();
                assert.throws(
                    () => setAuthHeaders(overLimit, { ...base, ...over }),
                    (err: unknown) => err instanceof HeaderValueTooLargeError && err.field === field && err.limit === 8192,
                );
                assert.deepStrictEqual([...overLimit.keys()], [], "a refused identity leaves no partial header");
            });
        }

        it("should measure the limit in characters, not bytes", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, roles: [], scopes: [], claims: { d: "é".repeat(8184) } });
            assert.strictEqual(headers.get("x-auth-claims")?.length, 8192);
        });

        it("should apply the claims limit after the propagatedClaims filter", () => {
            const headers = new Headers();
            setAuthHeaders(headers, { ...base, roles: [], scopes: [], claims: { keep: "k", blob: "x".repeat(20_000) } }, ["keep"]);
            assert.strictEqual(headers.get("x-auth-claims"), '{"keep":"k"}');
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
