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
 * Validate one `readMaxBytes` value; `caller` prefixes the message so the
 * server-level option and a service's own option fail in the same form.
 * `undefined` means "not set" and is accepted.
 *
 * @throws TypeError if the value is not a number
 * @throws RangeError if the value is not an integer from 1 to {@link MAX_READ_MAX_BYTES}
 * @internal
 */
export function validateReadMaxBytes(readMaxBytes: unknown, caller: string): void {
    if (readMaxBytes === undefined) {
        return;
    }
    if (typeof readMaxBytes !== "number") {
        throw new TypeError(`${caller}: readMaxBytes must be a number of bytes, got ${typeof readMaxBytes}`);
    }
    if (!Number.isInteger(readMaxBytes) || readMaxBytes < 1 || readMaxBytes > MAX_READ_MAX_BYTES) {
        throw new RangeError(`${caller}: readMaxBytes must be an integer from 1 to ${MAX_READ_MAX_BYTES} bytes, got ${String(readMaxBytes)}`);
    }
}

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
    validateReadMaxBytes(readMaxBytes, "createServer");
}

/** Largest delay `setTimeout` accepts; a larger one fires after about a millisecond. */
export const MAX_SHUTDOWN_TIMEOUT_MS = 2_147_483_647;

/**
 * Reject `shutdown` options that would otherwise misbehave silently: a `NaN`,
 * negative or oversized `timeout` makes the timer fire after about a
 * millisecond, so the graceful phase is skipped and live connections are cut.
 * `timeout: 0` stays valid: it means "do not wait".
 *
 * @throws TypeError if `timeout` is not a number or `forceCloseOnTimeout` is not a boolean
 * @throws RangeError if `timeout` is not an integer from 0 to {@link MAX_SHUTDOWN_TIMEOUT_MS}
 * @internal
 */
export function validateShutdownOptions(shutdown: CreateServerOptions["shutdown"]): void {
    if (shutdown === undefined) {
        return;
    }
    const { timeout, forceCloseOnTimeout } = shutdown;
    if (timeout !== undefined) {
        if (typeof timeout !== "number") {
            throw new TypeError(`createServer: shutdown.timeout must be a number of milliseconds, got ${typeof timeout}`);
        }
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_SHUTDOWN_TIMEOUT_MS) {
            throw new RangeError(`createServer: shutdown.timeout must be an integer from 0 to ${MAX_SHUTDOWN_TIMEOUT_MS} milliseconds, got ${String(timeout)}`);
        }
    }
    if (forceCloseOnTimeout !== undefined && typeof forceCloseOnTimeout !== "boolean") {
        throw new TypeError(`createServer: shutdown.forceCloseOnTimeout must be a boolean, got ${typeof forceCloseOnTimeout}`);
    }
}
