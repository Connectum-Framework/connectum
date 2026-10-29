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
