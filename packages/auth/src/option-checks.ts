/**
 * Creation-time checks for string options that end up in a header name, a header value or the
 * identity.
 *
 * A bad value of such an option does not fail where it is configured: it fails when a request
 * arrives, inside `Headers` or the header writer, and the caller sees an internal error. These
 * checks fail loudly when the interceptor is created, naming the option.
 *
 * @module option-checks
 */

import { isStringList } from "./auth-context-check.ts";
import { HEADER_BREAKING_CHARS, MAX_HEADER_BYTES } from "./headers.ts";

/** An HTTP token (RFC 9110 section 5.6.2): what a header name may consist of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A high surrogate without a low one after it, or a low surrogate without a high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Space or tab at the start or the end: `Headers.set` removes it, so the value would change on the wire. */
const EDGE_WHITESPACE = /^[ \t]|[ \t]$/;

/**
 * Check that `value` can be a header name; throws a `TypeError` naming `option` otherwise.
 *
 * @param option - The option path as the user wrote it, for the message (for example `trustSource.header`)
 * @param value - The configured header name
 */
export function assertHeaderName(option: string, value: unknown): asserts value is string {
    if (typeof value !== "string" || !HEADER_NAME.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must be a valid HTTP header name (letters, digits and the characters !#$%&'*+-.^_\`|~), got ${JSON.stringify(value)}`);
    }
}

/**
 * Check that `value` can be written as an identity text (`type`, `subject`) into an `x-auth-*`
 * header and read back: a non-empty string without NUL, CR or LF and without a lone surrogate, not
 * longer than `maxLength` characters. Throws a `TypeError` naming `option` otherwise.
 *
 * @param option - The option path for the message
 * @param value - The configured text
 * @param maxLength - The header limit of the field
 */
export function assertIdentityText(option: string, value: unknown, maxLength: number): asserts value is string {
    if (typeof value !== "string" || value === "") {
        throw new TypeError(`@connectum/auth: ${option} must be a non-empty string, got ${JSON.stringify(value)}`);
    }
    if (HEADER_BREAKING_CHARS.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must not contain NUL, CR or LF characters`);
    }
    if (LONE_SURROGATE.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must not contain a lone surrogate (it has no UTF-8 form)`);
    }
    if (value.length > maxLength) {
        throw new RangeError(`@connectum/auth: ${option} must be at most ${maxLength} characters, got ${value.length}`);
    }
}

/**
 * Check that `value` can be sent as a header value exactly as written: a non-empty string of
 * characters up to U+00FF without NUL, CR or LF and without a space or tab at either end. Throws a
 * `TypeError` naming `option` otherwise.
 *
 * @param option - The option path for the message
 * @param value - The configured secret
 */
export function assertHeaderValue(option: string, value: unknown): asserts value is string {
    if (typeof value !== "string" || value === "") {
        throw new TypeError(`@connectum/auth: ${option} must be a non-empty string`);
    }
    if (HEADER_BREAKING_CHARS.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must not contain NUL, CR or LF characters`);
    }
    if (/[Ā-\u{10FFFF}]/u.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must not contain characters above U+00FF (a header value is a byte string)`);
    }
    if (EDGE_WHITESPACE.test(value)) {
        throw new TypeError(`@connectum/auth: ${option} must not start or end with a space or tab (the platform removes it from a header value)`);
    }
}

/**
 * Check that `value` is a list of at most 8192 strings without holes whose JSON form fits the
 * roles header; throws a `TypeError` naming `option` otherwise.
 *
 * @param option - The option path for the message
 * @param value - The configured roles
 */
export function assertRolesList(option: string, value: unknown): asserts value is string[] {
    if (!isStringList(value)) {
        throw new TypeError(`@connectum/auth: ${option} must be an array of at most 8192 strings without holes`);
    }
    if (JSON.stringify(value).length > MAX_HEADER_BYTES) {
        throw new RangeError(`@connectum/auth: ${option} does not fit the roles header (limit ${MAX_HEADER_BYTES} characters)`);
    }
}
