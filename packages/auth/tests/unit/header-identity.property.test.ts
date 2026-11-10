/**
 * Property tests for the identity headers: every input either reads back unchanged or is refused.
 *
 * The invariant of property 1: the writer either throws one of the two errors its JSDoc documents
 * (`UnsafeHeaderValueError`, a `TypeError`, or `HeaderValueTooLargeError`, a `RangeError`) and
 * leaves the headers untouched, or the reader gives back the identity after the documented
 * sanitising, with a subject that is never empty. A subject that consists only of control
 * characters used to pass the writer's emptiness check and come back as `""`, which every caller
 * that treats "a context was returned" as "the caller is authenticated" accepted as an identity.
 * The value that found the defect, U+000E, is kept as an explicit example.
 *
 * The invariant of property 2: `parseAuthHeaders` reads arbitrary headers into `undefined`, into an
 * identity with a non-empty subject, or refuses with the only error its JSDoc documents, a
 * `ConnectError` with `Code.Unauthenticated`.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import fc from "fast-check";
import {
    HeaderValueTooLargeError,
    MAX_NAME_LENGTH,
    MAX_SUBJECT_LENGTH,
    MAX_TYPE_LENGTH,
    parseAuthHeaders,
    sanitizeHeaderValue,
    setAuthHeaders,
    UnsafeHeaderValueError,
} from "../../src/headers.ts";
import type { AuthContext } from "../../src/types.ts";

// The run parameters are literals until the shared property-test helper lands; it will supply
// them, so this file should not gain a copy of them.
const RUN = { numRuns: 200, seed: 20261111, endOnFailure: true } as const;

/** One unit of generated identity text: letters, a control character, text above U+00FF. */
const TEXT_UNITS = ["a", "b", "z", "0", " ", "\t", "\x01", "\x08", "\x0E", "\x1F", "\x7F", "é", "ÿ", "И", "\u{1F600}", "\u2028"];

/** A short text, possibly empty, possibly made only of control characters. */
const text = fc.array(fc.constantFrom(...TEXT_UNITS), { maxLength: 6 }).map((units) => units.join(""));

/** A text of a length around `limit`, so the limit itself is exercised. */
function around(limit: number): fc.Arbitrary<string> {
    return fc.integer({ min: limit - 2, max: limit + 2 }).map((length) => "a".repeat(length));
}

/** A text in a claim: any JSON scalar the identity accepts. */
const claimValue = fc.oneof(
    fc.string({ unit: fc.constantFrom("a", "é", "\x01", " "), maxLength: 4 }),
    fc.integer({ min: -10, max: 10 }),
    fc.boolean(),
    fc.constant(null),
);

/** An identity of the shapes `AuthContext` allows, with lengths around every header limit. */
const identity: fc.Arbitrary<AuthContext> = fc.record({
    subject: fc.oneof({ arbitrary: text, weight: 3 }, { arbitrary: around(MAX_SUBJECT_LENGTH), weight: 1 }),
    type: fc.oneof({ arbitrary: text, weight: 3 }, { arbitrary: around(MAX_TYPE_LENGTH), weight: 1 }),
    name: fc.oneof(fc.constant(undefined), text, around(MAX_NAME_LENGTH)),
    roles: fc.array(text, { maxLength: 3 }),
    scopes: fc.array(text, { maxLength: 3 }),
    claims: fc.dictionary(fc.constantFrom("k", "role", "n", ""), claimValue, { maxKeys: 3 }),
});

/** One unit of a header value sent by somebody else: bytes a header can carry, and encoding syntax. */
const HEADER_UNITS = ["a", "s", " ", "\t", "\x01", "\x0E", "\x7F", "%", "%00", "%0D", "%0A", "%D0", "%98", "utf-8''", "'", "é", "ÿ", "8"];

/** A header value, including malformed percent-encodings and values near the subject limit. */
const headerValue = fc.oneof(
    { arbitrary: fc.array(fc.constantFrom(...HEADER_UNITS), { maxLength: 10 }).map((units) => units.join("")), weight: 3 },
    { arbitrary: around(MAX_SUBJECT_LENGTH), weight: 1 },
);

/** The headers a reader can be handed: any value in the identity names, with or without the marker. */
const identityHeaders = fc.record({
    subject: headerValue,
    type: headerValue,
    name: headerValue,
    roles: headerValue,
    scopes: headerValue,
    claims: headerValue,
    marker: fc.boolean(),
});

/**
 * The writer throws one of the two documented errors or writes an identity that reads back as
 * written, with a subject that is never empty.
 */
describe("every identity the writer accepts reads back with a non-empty subject", () => {
    it("holds for generated identities, with the headers untouched on every refusal", () => {
        fc.assert(
            fc.property(identity, (context) => {
                const headers = new Headers({ "x-pre-existing": "kept" });
                try {
                    setAuthHeaders(headers, context);
                } catch (err) {
                    assert.ok(
                        err instanceof UnsafeHeaderValueError || err instanceof HeaderValueTooLargeError,
                        `a refusal must be one of the two documented errors, got ${String(err)}`,
                    );
                    assert.deepStrictEqual(
                        [...headers],
                        [["x-pre-existing", "kept"]],
                        "a refused identity leaves the headers exactly as they were",
                    );
                    return;
                }

                const parsed = parseAuthHeaders(headers);
                assert.ok(parsed, "an identity the writer accepted must read back");
                assert.notStrictEqual(parsed.subject, "", "the subject of a written identity is never empty");
                assert.strictEqual(parsed.subject, sanitizeHeaderValue(context.subject, MAX_SUBJECT_LENGTH), "the subject after the documented sanitising");
                assert.strictEqual(parsed.type, sanitizeHeaderValue(context.type, MAX_TYPE_LENGTH), "the type after the documented sanitising");
                const name = context.name ? sanitizeHeaderValue(context.name, MAX_NAME_LENGTH) : undefined;
                assert.strictEqual(parsed.name, name === "" ? undefined : name, "the name after the documented sanitising");
                assert.deepStrictEqual(parsed.roles, context.roles, "roles are read as written");
                assert.deepStrictEqual(parsed.scopes, context.scopes, "scopes are read as granted");
                // Claims travel as JSON, so the reader gives an ordinary object; the generated one
                // may have another prototype (fast-check builds records without one).
                assert.deepStrictEqual(parsed.claims, { ...context.claims }, "claims are read as written");
            }),
            { ...RUN, examples: [[{ subject: "\u000e", type: "jwt", roles: [], scopes: [], claims: {} }]] },
        );
    });

    it("a subject of U+000E only is refused on write and yields no identity on read", () => {
        const found: AuthContext = { subject: "\u000e", type: "jwt", roles: [], scopes: [], claims: {} };

        assert.throws(() => setAuthHeaders(new Headers(), found), UnsafeHeaderValueError);
        assert.strictEqual(parseAuthHeaders(new Headers({ "x-auth-subject": "\u000e" })), undefined);
    });
});

/**
 * The reader does one of three documented things with arbitrary headers: no identity, an identity
 * with a subject, or `Code.Unauthenticated`. Anything else — a subject an authenticated caller
 * would then use, an `internal` error — is a defect.
 */
describe("reading arbitrary headers gives no identity, a subject, or Unauthenticated", () => {
    it("holds for generated header values", () => {
        fc.assert(
            fc.property(identityHeaders, (generated) => {
                const headers = new Headers();
                headers.set("x-auth-subject", generated.subject);
                headers.set("x-auth-type", generated.type);
                headers.set("x-auth-name", generated.name);
                headers.set("x-auth-roles", generated.roles);
                headers.set("x-auth-scopes", generated.scopes);
                headers.set("x-auth-claims", generated.claims);
                if (generated.marker) headers.set("x-auth-encoding", "percent-utf8");

                let parsed: AuthContext | undefined;
                try {
                    parsed = parseAuthHeaders(headers);
                } catch (err) {
                    assert.ok(err instanceof ConnectError, `the reader may only refuse with a ConnectError, got ${String(err)}`);
                    assert.strictEqual(err.code, Code.Unauthenticated, "the only refusal the reader documents is Unauthenticated");
                    return;
                }
                if (parsed !== undefined) assert.notStrictEqual(parsed.subject, "", "a returned identity always has a subject");
            }),
            RUN,
        );
    });
});
