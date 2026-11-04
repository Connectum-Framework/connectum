/**
 * Creation-time checks for string options that end up in a header name, a header value or the
 * identity.
 *
 * A bad value of such an option does not fail where it is configured: it fails when a request
 * arrives, inside `Headers` or the header writer, and the caller sees an internal error. These
 * checks fail loudly when the interceptor is created, naming the option.
 *
 * Each check runs the very operation the request path performs instead of restating its rules: an
 * identity text or a roles list goes through {@link setAuthHeaders}, a header name and a secret
 * through `Headers`. A second copy of a limit or a rule would drift (the roles JSON, for example,
 * grows by five characters for each character above U+00FF), and a configuration would then be
 * accepted here and refused on every request, or the other way round.
 *
 * @module option-checks
 */

import { HeaderValueTooLargeError, setAuthHeaders, UnsafeHeaderValueError } from "./headers.ts";
import type { AuthContext } from "./types.ts";

/** An identity with plain values everywhere, so that only the field under test can make the writer refuse it. */
const PLAIN_IDENTITY: AuthContext = { subject: "subject", type: "type", roles: [], scopes: [], claims: {} };

/**
 * Check that `value` can be used as a header name; throws a `TypeError` naming `option` otherwise.
 * The platform decides: a name that `Headers` refuses, or an empty one, fails every request.
 *
 * @param option - The option path as the user wrote it, for the message (for example `trustSource.header`)
 * @param value - The configured header name
 */
export function assertHeaderName(option: string, value: unknown): asserts value is string {
    let valid = typeof value === "string" && value !== "";
    if (valid) {
        try {
            new Headers().has(value as string);
        } catch {
            valid = false;
        }
    }
    if (!valid) {
        throw new TypeError(`@connectum/auth: ${option} must be a valid HTTP header name (letters, digits and the characters !#$%&'*+-.^_\`|~), got ${JSON.stringify(value)}`);
    }
}

/**
 * Check that `value` can be set on a request as a header value and read back unchanged: a
 * non-empty string that `Headers` accepts (no NUL, CR or LF, no character above U+00FF) and does not
 * alter (it removes a space or tab at either end). Throws a `TypeError` naming `option` otherwise.
 *
 * @param option - The option path for the message
 * @param value - The configured secret
 */
export function assertHeaderValue(option: string, value: unknown): asserts value is string {
    let delivered = typeof value === "string" && value !== "";
    if (delivered) {
        try {
            const headers = new Headers();
            headers.set("x-check", value as string);
            delivered = headers.get("x-check") === value;
        } catch {
            delivered = false;
        }
    }
    if (!delivered) {
        throw new TypeError(
            `@connectum/auth: ${option} must be a non-empty string that a header value carries unchanged: no NUL, CR or LF, no character above U+00FF, and no space or tab at either end (the platform removes it)`,
        );
    }
}

/**
 * Check that the header writer accepts `patch` in an otherwise plain identity: runs
 * {@link setAuthHeaders} on a scratch `Headers` and turns its refusal into an error naming `option`
 * (a `RangeError` for a size, a `TypeError` for everything else). The writer is the one place that
 * knows the limits, the expansion of non-Latin text in JSON and the rules for empty values, lone
 * surrogates and lists.
 *
 * @param option - The option path for the message
 * @param patch - The identity fields that carry the configured value
 */
export function assertWritable(option: string, patch: Partial<AuthContext>): void {
    for (const [field, value] of Object.entries(patch)) {
        if ((field === "subject" || field === "type") && typeof value !== "string") {
            throw new TypeError(`@connectum/auth: ${option} must be a string, got ${JSON.stringify(value)}`);
        }
    }
    try {
        setAuthHeaders(new Headers(), { ...PLAIN_IDENTITY, ...patch });
    } catch (err) {
        if (err instanceof HeaderValueTooLargeError) {
            throw new RangeError(`@connectum/auth: ${option}: ${err.message}`, { cause: err });
        }
        if (err instanceof UnsafeHeaderValueError) {
            throw new TypeError(`@connectum/auth: ${option}: ${err.message}`, { cause: err });
        }
        throw err;
    }
}
