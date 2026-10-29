/**
 * Validation of the inputs of catalog calls and of the catalog configuration.
 *
 * Mistakes in these inputs used to be accepted and to surface later as a lifted
 * deadline, a thrown `Headers` error on every call, or a server that mounts
 * nothing. Each check here names the offending option so the fix is obvious.
 *
 * @module catalogOptions
 */

import { Code, ConnectError, type Transport } from "@connectrpc/connect";
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

/**
 * A `remoteResolver` returned something other than a `Transport` or `null`.
 * A distinct class so the call sites that wrap a throwing resolver ("the
 * resolver threw") let this one through unchanged: the resolver did not throw,
 * it broke its contract, and its message already says how.
 *
 * @internal
 */
export class InvalidResolverResultError extends ConnectError {
    constructor(message: string) {
        super(message, Code.Internal);
        Object.setPrototypeOf(this, InvalidResolverResultError.prototype);
    }
}

/** Describe a value for an error message without printing its contents. */
function describeValue(value: unknown): string {
    if (value === null) return "null";
    if (typeof value !== "object") return typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name !== "Object" ? `an object (${name})` : "an object";
}

/**
 * Check what a `remoteResolver` returned for `typeName` and narrow it to a
 * `Transport`. The framework caches the result per route and calls
 * `transport.unary` / `transport.stream` on it, so anything else (a string, a
 * `Promise` from an `async` resolver, `undefined` from a helper that found no
 * entry) would be cached and then fail on every call with a message that names
 * neither the resolver nor the service. `null` ("no route") is the caller's
 * business and must be handled before this check.
 *
 * @throws InvalidResolverResultError (`Code.Internal`) naming the service and what was returned
 * @internal
 */
export function assertResolvedTransport(resolved: unknown, typeName: string): Transport {
    if (typeof resolved === "object" && resolved !== null && typeof (resolved as Transport).unary === "function" && typeof (resolved as Transport).stream === "function") {
        return resolved as Transport;
    }
    let what = describeValue(resolved);
    let hint = "A remoteResolver must return a Transport (an object with unary and stream functions) or null.";
    if (typeof (resolved as { then?: unknown } | null)?.then === "function") {
        // The promise is abandoned here: without a handler its rejection would
        // crash the process on top of the configuration error reported below.
        (resolved as Promise<unknown>).then(undefined, () => {});
        what = "a Promise";
        hint = "A remoteResolver must be synchronous: it cannot be declared async or return a Promise, because the framework caches its result per route and cannot await it.";
    }
    throw new InvalidResolverResultError(`The remoteResolver returned ${what} for "${typeName}". ${hint}`);
}

/**
 * Treat an empty `endpoint` as an absent one. The transport cache already keys
 * both the same way, so the resolver must be handed the same context for both:
 * otherwise what it sees (and which transport every later call reuses) would
 * depend on which call happened to come first.
 *
 * @internal
 */
export function normalizeEndpoint(endpoint: string | undefined): string | undefined {
    return endpoint === "" ? undefined : endpoint;
}
