/**
 * Auth header propagation utilities
 *
 * Handles serialization/deserialization of AuthContext to/from
 * HTTP headers for cross-service context propagation.
 *
 * @module headers
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { isStringList, MAX_LIST_ITEMS } from "./auth-context-check.ts";
import type { AuthContext } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/** Maximum length for the value of the roles, scopes and claims headers (shared with client interceptors). */
export const MAX_HEADER_BYTES = 8192;

/** Longest `subject`, `type` and `name` that fit their headers; a longer value is refused instead of cut. */
export const MAX_SUBJECT_LENGTH = 512;
/** Longest `type` that fits `x-auth-type`. */
export const MAX_TYPE_LENGTH = 128;
/** Longest `name` that fits `x-auth-name`. */
export const MAX_NAME_LENGTH = 256;

/**
 * Prefix of a header text that holds characters above U+00FF: the prefix of an RFC 8187 `ext-value`
 * without a language, followed by the UTF-8 bytes of the text, percent-encoded. A header value is a
 * byte string, so such a text cannot be written as is.
 */
const ENCODED_TEXT_PREFIX = "utf-8''";

/**
 * Value of the `x-auth-encoding` header that a writer sets when it encoded at least one text. A reader
 * decodes `utf-8''` texts only when the header is present, so a service that never sends the marker
 * (an older version, another gateway) keeps its literal `utf-8''admin` as the literal text it is.
 */
export const TEXT_ENCODING_MARKER = "percent-utf8";

/** Whether the sender declared that it encodes texts above U+00FF (see {@link TEXT_ENCODING_MARKER}). */
export function declaresTextEncoding(headers: Headers): boolean {
    return headers.get(AUTH_HEADERS.ENCODING) === TEXT_ENCODING_MARKER;
}

/**
 * Sanitize a header value by removing control characters and enforcing length limits.
 *
 * Tab, LF and CR are kept by this function itself; on the write path
 * ({@link setAuthHeaders}) LF, CR and NUL never get here because an identity holding
 * one of them is refused first.
 */
export function sanitizeHeaderValue(value: string, maxLength: number): string {
    // Remove control characters (except tab/LF/CR which are valid in headers)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal for header sanitization
    const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    return cleaned.slice(0, maxLength);
}

/**
 * Thrown by {@link setAuthHeaders} when an identity field cannot be written into a header
 * without changing it: NUL, CR or LF in `subject`, `type`, `name` or a scope, a lone surrogate
 * (it has no UTF-8 form), or a scope that is empty or has a space (the next hop splits the scopes
 * header on spaces and drops empty pieces, so it would read one scope as several or lose the empty
 * one), or a `roles` or `scopes` value that is not a list of at most
 * 8192 strings without holes. `field` names the offending `AuthContext` field.
 */
export class UnsafeHeaderValueError extends TypeError {
    readonly field: "subject" | "type" | "name" | "roles" | "scopes";

    constructor(field: UnsafeHeaderValueError["field"], reason: "text" | "list" | "empty" = "text") {
        const spaceRule = field === "scopes" ? ", and a scope may not be empty or contain a space" : "";
        const messages = {
            text: `AuthContext.${field} must not contain NUL, CR or LF characters or a lone surrogate${spaceRule}, when auth headers are propagated`,
            list: `AuthContext.${field} must be an array of at most ${MAX_LIST_ITEMS} strings without holes, when auth headers are propagated`,
            empty: `AuthContext.${field} must not be empty, when auth headers are propagated (the reader would not read it back)`,
        };
        super(messages[reason]);
        this.name = "UnsafeHeaderValueError";
        this.field = field;
    }
}

/**
 * Thrown by {@link setAuthHeaders} when an identity field does not fit its header: a `subject`
 * longer than 512 characters, a `type` longer than 128, a `name` longer than 256, or roles, scopes
 * or claims whose serialized value is longer than 8192 characters. Cutting or dropping the value
 * would hand the next hop a different identity (two subjects that share their first 512 characters
 * become one; a role that denies access disappears), so the identity is refused instead.
 */
export class HeaderValueTooLargeError extends RangeError {
    readonly field: "subject" | "type" | "name" | "roles" | "scopes" | "claims";
    readonly limit: number;

    constructor(field: HeaderValueTooLargeError["field"], limit: number) {
        super(`AuthContext.${field} does not fit its auth header (limit ${limit} characters); it is refused rather than cut or left out`);
        this.name = "HeaderValueTooLargeError";
        this.field = field;
        this.limit = limit;
    }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL, CR and LF are exactly the characters being detected
export const HEADER_BREAKING_CHARS = /[\x00\r\n]/;

/**
 * Write a text into a header value without loss. A text of characters up to U+00FF that does
 * not start with the encoded-text prefix and has no space or tab at either end is written as is,
 * so ASCII and Latin-1 values are unchanged on the wire. Any other text is written as `utf-8''`
 * followed by its percent-encoded UTF-8 bytes. A text that itself starts with the prefix is
 * encoded too, so reading is unambiguous. A space or tab at an end is encoded because
 * `Headers.set` removes it from every value, so a subject of U+0020 followed by `alice` would
 * reach the next hop as `alice`.
 *
 * @throws {URIError} When the text holds a lone surrogate
 */
export function encodeHeaderText(text: string): string {
    // Every UTF-16 unit above U+00FF, surrogates included, is outside a header byte string.
    if (!/[Ā-￿]/.test(text) && !text.startsWith(ENCODED_TEXT_PREFIX) && !/^[ \t]|[ \t]$/.test(text)) return text;
    return ENCODED_TEXT_PREFIX + encodeURIComponent(text);
}

/**
 * Read a header value written by {@link encodeHeaderText}. A value without the prefix is returned as is.
 *
 * @throws {URIError} When the percent-encoding is malformed or is not UTF-8
 */
export function decodeHeaderText(raw: string): string {
    return raw.startsWith(ENCODED_TEXT_PREFIX) ? decodeURIComponent(raw.slice(ENCODED_TEXT_PREFIX.length)) : raw;
}

/** The refusal a reader answers when a propagated header cannot be read back without loss. */
function unreadable(): ConnectError {
    return new ConnectError("Authentication failed", Code.Unauthenticated);
}

/**
 * Read one identity text from a header value.
 *
 * `raw` is decoded only when `decode` is true (the sender declared the encoding). The result is
 * held to the rules the writer enforces, whichever way it was obtained: text with NUL, CR or LF is
 * refused (a writer never emits it, and a percent-encoded `%00`, `%0D` or `%0A` must not smuggle
 * what a raw header cannot carry). With `strip` the other control characters (C0 except tab, and
 * DEL) are removed as the writer removes them from a subject, type or name, so a decoded text
 * ends up exactly as a raw one would; scopes are read as granted and pass `strip: false`. The
 * length of the decoded text is checked against `limit` before the cleaning; a longer value is
 * refused instead of cut or accepted shortened.
 */
export function readHeaderText(raw: string, limit: number, decode: boolean, strip: boolean): string {
    let text: string;
    try {
        text = decode ? decodeHeaderText(raw) : raw;
    } catch {
        throw unreadable();
    }
    if (HEADER_BREAKING_CHARS.test(text)) throw unreadable();
    // The limit is checked on the text as it arrives, before the cleaning: a value one character
    // over the limit whose extra character is a control would otherwise shrink to the limit and be
    // accepted shortened. The writer applies its limit to the original text in the same order.
    if (text.length > limit) throw unreadable();
    return strip ? sanitizeHeaderValue(text, Number.POSITIVE_INFINITY) : text;
}

/**
 * Find the first identity field that cannot be written into a header.
 *
 * NUL, CR and LF are rejected rather than stripped: removing a line break would turn two
 * different subjects (`al\nice` and `alice`) into the same header value, merging their identities
 * downstream. Characters above U+00FF are not a problem: they are written with {@link encodeHeaderText}.
 * Scopes are checked one by one and are otherwise left exactly as granted, because an edited scope
 * could match a privilege nobody granted. A scope that contains a space is refused for the
 * same reason: scopes are joined and split on a space, so the next hop would read the one
 * granted scope `reports read admin` as three, `admin` among them. Whitespace at the edges
 * of the other values keeps the behavior of the platform.
 */
function findUnsafeField(context: AuthContext): UnsafeHeaderValueError["field"] | undefined {
    if (HEADER_BREAKING_CHARS.test(context.subject)) return "subject";
    if (HEADER_BREAKING_CHARS.test(context.type)) return "type";
    if (context.name && HEADER_BREAKING_CHARS.test(context.name)) return "name";
    if (context.scopes.some((scope) => scope === "" || HEADER_BREAKING_CHARS.test(scope) || scope.includes(" "))) return "scopes";
    return undefined;
}

/** {@link encodeHeaderText} for one identity field; a lone surrogate is an unsafe value of that field. */
function encodeField(field: UnsafeHeaderValueError["field"], text: string): string {
    try {
        return encodeHeaderText(text);
    } catch {
        throw new UnsafeHeaderValueError(field);
    }
}

/**
 * Serialize roles or claims for a header. JSON may hold any text, a header value only bytes,
 * so each character above U+00FF is written as a `\uXXXX` escape; the reader's `JSON.parse`
 * restores the original value, nothing is lost and the other characters stay as they are.
 */
function jsonForHeader(value: unknown): string {
    return JSON.stringify(value).replace(/[Ā-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Write an identity into request headers for downstream services, or reject the call.
 *
 * Interceptors use this instead of {@link setAuthHeaders} so that an identity which cannot
 * be propagated ends the request with `Code.Unauthenticated` (and is never cached) instead
 * of surfacing as an internal error. That covers every failure of {@link setAuthHeaders}, not only
 * the ones it names: a claim that cannot be serialized (cyclic, `BigInt`, a throwing `toJSON` or
 * getter, a proxy whose trap throws) fails the same way. The original error is the `cause`.
 *
 * @param headers - Headers object to set auth headers on
 * @param context - Auth context to serialize
 * @param propagatedClaims - Optional list of claim keys to propagate (all if undefined)
 * @throws {ConnectError} `Code.Unauthenticated` when the identity holds NUL, CR or LF, an empty scope or a scope with a space,
 *   a value that does not fit its header, or a claim that cannot be serialized
 */
export function propagateAuthHeaders(headers: Headers, context: AuthContext, propagatedClaims?: string[]): void {
    try {
        setAuthHeaders(headers, context, propagatedClaims);
    } catch (err) {
        throw new ConnectError("Authentication failed", Code.Unauthenticated, undefined, undefined, err);
    }
}

/**
 * Serialize AuthContext to request headers.
 *
 * Sets standard auth headers on the provided Headers object, all or none.
 * Used by auth interceptors when propagateHeaders is enabled.
 *
 * `subject`, `type` and `name` have control characters removed (tab is kept); text above U+00FF is
 * written as `utf-8''` plus percent-encoded UTF-8, everything else is unchanged. Roles and claims
 * are JSON (characters above U+00FF are written as `\uXXXX` escapes, which the reader restores);
 * scopes are written as granted. Nothing is cut or left out: an identity that does not fit is
 * refused.
 *
 * @param headers - Headers object to set auth headers on
 * @param context - Auth context to serialize
 * @param propagatedClaims - Optional list of claim keys to propagate (all if undefined)
 * @throws {TypeError} (`UnsafeHeaderValueError`) When `subject`, `type`, `name` or a scope contains NUL, CR or LF or a lone surrogate,
 *   or a scope is empty or contains a space, or `roles` or `scopes` is not an array of at most 8192 strings without holes;
 *   the message names the field and no header has been set
 * @throws {RangeError} (`HeaderValueTooLargeError`) When `subject` is longer than 512 characters, `type` than 128, `name` than 256,
 *   or the serialized roles, scopes or claims than 8192; no header has been set
 */
export function setAuthHeaders(headers: Headers, context: AuthContext, propagatedClaims?: string[]): void {
    // Lists first: the checks below walk them, and `some`, `map` and `join` skip holes, which would
    // write a changed list instead of refusing it.
    if (!isStringList(context.roles)) throw new UnsafeHeaderValueError("roles", "list");
    if (!isStringList(context.scopes)) throw new UnsafeHeaderValueError("scopes", "list");
    // An empty subject or type is written as an empty header, which the reader treats as absent
    // (no identity at all, or the type "unknown"), so it would not read back as written.
    if (context.subject === "") throw new UnsafeHeaderValueError("subject", "empty");
    if (context.type === "") throw new UnsafeHeaderValueError("type", "empty");
    const unsafeField = findUnsafeField(context);
    if (unsafeField) {
        throw new UnsafeHeaderValueError(unsafeField);
    }
    if (context.subject.length > MAX_SUBJECT_LENGTH) throw new HeaderValueTooLargeError("subject", MAX_SUBJECT_LENGTH);
    if (context.type.length > MAX_TYPE_LENGTH) throw new HeaderValueTooLargeError("type", MAX_TYPE_LENGTH);
    if (context.name && context.name.length > MAX_NAME_LENGTH) throw new HeaderValueTooLargeError("name", MAX_NAME_LENGTH);

    // Build every value first so that a refusal leaves the headers untouched. The encoding marker is
    // set when at least one text was encoded: only then does a reader treat `utf-8''` as a prefix.
    let encodedAny = false;
    /** Encode one text for its header and remember that the encoding marker is needed. */
    const encode = (field: UnsafeHeaderValueError["field"], text: string): string => {
        const encoded = encodeField(field, text);
        if (encoded !== text) encodedAny = true;
        return encoded;
    };
    const toSet: Array<[string, string]> = [
        [AUTH_HEADERS.SUBJECT, encode("subject", sanitizeHeaderValue(context.subject, MAX_SUBJECT_LENGTH))],
        [AUTH_HEADERS.TYPE, encode("type", sanitizeHeaderValue(context.type, MAX_TYPE_LENGTH))],
    ];

    if (context.name) {
        toSet.push([AUTH_HEADERS.NAME, encode("name", sanitizeHeaderValue(context.name, MAX_NAME_LENGTH))]);
    }

    if (context.roles.length > 0) {
        const rolesValue = jsonForHeader(context.roles);
        if (rolesValue.length > MAX_HEADER_BYTES) throw new HeaderValueTooLargeError("roles", MAX_HEADER_BYTES);
        toSet.push([AUTH_HEADERS.ROLES, rolesValue]);
    }

    if (context.scopes.length > 0) {
        const scopesValue = context.scopes.map((scope) => encode("scopes", scope)).join(" ");
        if (scopesValue.length > MAX_HEADER_BYTES) throw new HeaderValueTooLargeError("scopes", MAX_HEADER_BYTES);
        toSet.push([AUTH_HEADERS.SCOPES, scopesValue]);
    }

    const claimKeys = Object.keys(context.claims);
    if (claimKeys.length > 0) {
        const filteredClaims = propagatedClaims ? Object.fromEntries(Object.entries(context.claims).filter(([key]) => propagatedClaims.includes(key))) : context.claims;
        if (Object.keys(filteredClaims).length > 0) {
            const claimsValue = jsonForHeader(filteredClaims);
            if (claimsValue.length > MAX_HEADER_BYTES) throw new HeaderValueTooLargeError("claims", MAX_HEADER_BYTES);
            toSet.push([AUTH_HEADERS.CLAIMS, claimsValue]);
        }
    }

    if (encodedAny) toSet.push([AUTH_HEADERS.ENCODING, TEXT_ENCODING_MARKER]);

    for (const [name, value] of toSet) headers.set(name, value);
}

/**
 * Parse AuthContext from request headers.
 *
 * Deserializes auth context from standard headers set by an upstream
 * service or gateway. Returns undefined if required headers are missing.
 *
 * Nothing is cut or ignored: a header that cannot be read back without loss (a value longer than
 * its limit, a malformed `utf-8''` text, a decoded text with NUL, CR or LF) is refused. Other C0 controls and
 * DEL are removed from the subject, type and name, raw or decoded, as the writer removes them.
 *
 * WARNING: Only use this in trusted environments (behind mTLS, mesh, etc.).
 * For gateway requests, use createGatewayAuthInterceptor() with a verified trust header.
 *
 * @param headers - Request headers to parse
 * @returns Parsed AuthContext or undefined if headers are missing
 * @throws {ConnectError} `Code.Unauthenticated` when a header holds a value longer than its limit or a malformed encoded text
 *
 * @example Trust upstream auth headers
 * ```typescript
 * import { parseAuthHeaders } from '@connectum/auth';
 *
 * const context = parseAuthHeaders(req.header);
 * if (context) {
 *   console.log(`Authenticated as ${context.subject}`);
 * }
 * ```
 */
export function parseAuthHeaders(headers: Headers): AuthContext | undefined {
    const subjectHeader = headers.get(AUTH_HEADERS.SUBJECT);
    if (!subjectHeader) {
        return undefined;
    }

    const decode = declaresTextEncoding(headers);
    const subject = readHeaderText(subjectHeader, MAX_SUBJECT_LENGTH, decode, true);
    const typeHeader = headers.get(AUTH_HEADERS.TYPE);
    const type = typeHeader ? readHeaderText(typeHeader, MAX_TYPE_LENGTH, decode, true) : "unknown";
    const rolesRaw = headers.get(AUTH_HEADERS.ROLES);
    const scopesRaw = headers.get(AUTH_HEADERS.SCOPES);
    const claimsRaw = headers.get(AUTH_HEADERS.CLAIMS);

    let roles: string[] = [];
    if (rolesRaw) {
        if (rolesRaw.length > MAX_HEADER_BYTES) throw unreadable();
        try {
            const parsed: unknown = JSON.parse(rolesRaw);
            if (Array.isArray(parsed)) {
                roles = parsed.filter((r): r is string => typeof r === "string");
            }
        } catch {
            // Invalid JSON — ignore malformed header
        }
    }

    let scopes: string[] = [];
    if (scopesRaw) {
        if (scopesRaw.length > MAX_HEADER_BYTES) throw unreadable();
        scopes = scopesRaw
            .split(" ")
            .filter(Boolean)
            .map((scope) => readHeaderText(scope, MAX_HEADER_BYTES, decode, false));
    }

    const nameRaw = headers.get(AUTH_HEADERS.NAME);
    const name = nameRaw ? readHeaderText(nameRaw, MAX_NAME_LENGTH, decode, true) : undefined;

    let claims: Record<string, unknown> = {};
    if (claimsRaw) {
        if (claimsRaw.length > MAX_HEADER_BYTES) throw unreadable();
        try {
            const parsed: unknown = JSON.parse(claimsRaw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                claims = parsed as Record<string, unknown>;
            }
        } catch {
            // Invalid JSON — ignore malformed header
        }
    }

    return {
        subject,
        name,
        type,
        roles,
        scopes,
        claims,
    };
}
