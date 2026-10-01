/**
 * Construction-time validation of the server-level request admission options
 * (`requestGate`, `readMaxBytes`).
 *
 * @module admission
 */

import type { CreateServerOptions } from "./types.ts";

/**
 * Largest `readMaxBytes` Connect accepts (its internal `maxReadMaxBytes`,
 * 0xffffffff). Connect does not export the constant; a unit test pins this
 * value against Connect's own range check so a change upstream is caught.
 *
 * @internal
 */
export const MAX_READ_MAX_BYTES = 0xffff_ffff;

/**
 * Reject admission options that would otherwise misbehave silently or fail
 * late. Connect's own range check lets `NaN` through (every comparison with
 * `NaN` is false), which disables the limit, treats `1.5` as `1`, and reports
 * `0`, negatives and `Infinity` only when routes are first built, as an opaque
 * `ConnectError(Internal)`. Failing in `createServer()` with an error that
 * names the option makes a misconfigured security limit impossible to miss.
 *
 * @throws TypeError if `readMaxBytes` is not a number or `requestGate` is not a function
 * @throws RangeError if `readMaxBytes` is not an integer from 1 to {@link MAX_READ_MAX_BYTES}
 * @internal
 */
export function validateAdmissionOptions(options: Pick<CreateServerOptions, "requestGate" | "readMaxBytes">): void {
    const { requestGate, readMaxBytes } = options;
    if (requestGate !== undefined && typeof requestGate !== "function") {
        throw new TypeError(`createServer: requestGate must be a function, got ${typeof requestGate}`);
    }
    if (readMaxBytes === undefined) {
        return;
    }
    if (typeof readMaxBytes !== "number") {
        throw new TypeError(`createServer: readMaxBytes must be a number of bytes, got ${typeof readMaxBytes}`);
    }
    if (!Number.isInteger(readMaxBytes) || readMaxBytes < 1 || readMaxBytes > MAX_READ_MAX_BYTES) {
        throw new RangeError(`createServer: readMaxBytes must be an integer from 1 to ${MAX_READ_MAX_BYTES} bytes, got ${String(readMaxBytes)}`);
    }
}
