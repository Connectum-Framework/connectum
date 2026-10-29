/**
 * Validation of the inputs of catalog calls and of the catalog configuration.
 *
 * Mistakes in these inputs used to be accepted and to surface later as a lifted
 * deadline, a thrown `Headers` error on every call, or a server that mounts
 * nothing. Each check here names the offending option so the fix is obvious.
 *
 * @module catalogOptions
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { CatalogConfigError } from "./catalogErrors.ts";

/**
 * Check a caller-supplied `CallOptions.timeoutMs` and return it (or `undefined`
 * when not set). A transport reads a non-positive timeout as "no deadline", so
 * `0` or a negative number would lift the limit the call inherits, and `NaN` /
 * `Infinity` produce different failures locally and over the wire. It is a
 * call-time input rather than configuration, so the failure is a `ConnectError`.
 *
 * @throws ConnectError with `Code.InvalidArgument` if the value is not a finite number greater than zero
 * @internal
 */
export function assertCallTimeout(timeoutMs: unknown): number | undefined {
    if (timeoutMs === undefined) {
        return undefined;
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new ConnectError(`CallOptions.timeoutMs must be a finite number of milliseconds greater than 0, got ${String(timeoutMs)}.`, Code.InvalidArgument);
    }
    return timeoutMs;
}

/** An HTTP field name is a non-empty run of `tchar` (RFC 9110, section 5.6.2); a pseudo-header starts with `:`, which is not one. */
const HEADER_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Check `createServer({ propagateHeaders })`. Every entry is later read with
 * `Headers.get`, which throws for a malformed name on every `ctx.call`, long
 * after the server started.
 *
 * @throws TypeError naming `propagateHeaders` if the value is not an array of valid header field names
 * @internal
 */
export function validatePropagateHeaders(propagateHeaders: unknown): void {
    if (propagateHeaders === undefined) {
        return;
    }
    if (!Array.isArray(propagateHeaders)) {
        throw new TypeError(`createServer: propagateHeaders must be an array of header names, got ${typeof propagateHeaders}`);
    }
    for (const name of propagateHeaders as unknown[]) {
        if (typeof name !== "string" || !HEADER_FIELD_NAME.test(name)) {
            throw new TypeError(
                `createServer: propagateHeaders entry ${JSON.stringify(name)} is not a valid HTTP header name (a non-empty token such as "x-request-id"; pseudo-headers like ":authority" are not allowed)`,
            );
        }
    }
}

/**
 * Check, at `start()`, that every `enabledServices` entry names a service the
 * server was given. An entry that matches none mounts nothing, so a misspelled
 * type name (often read from an environment variable) would otherwise leave a
 * running server whose every call is `unimplemented`.
 *
 * @param supplied - type names of the services in `services`, including those added with `addService()`
 * @throws CatalogConfigError naming the unknown entries and the type names available
 * @internal
 */
export function assertEnabledServicesAreSupplied(enabledServices: readonly string[], supplied: ReadonlySet<string>): void {
    const unknown = enabledServices.filter((name) => !supplied.has(name));
    if (unknown.length === 0) {
        return;
    }
    const available = [...supplied];
    throw new CatalogConfigError(
        `enabledServices lists ${unknown.length} typeName(s) that match none of the services passed to createServer: ${unknown.join(", ")}. ` +
            `Services available: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
    );
}
