/**
 * Maps the `error_code` of a gRPC reflection `ErrorResponse` to a Connect code.
 *
 * gRPC status codes 1–16 have the same numeric values as Connect's `Code`, so
 * they pass through unchanged. `0` (OK) has no Connect counterpart, and any other
 * value comes from a misbehaving server; both become `Code.Unknown`, so callers
 * that compare against a specific code (for example `Code.Unimplemented` when
 * falling back from v1 to v1alpha) never see a code Connect does not define.
 *
 * @module utils/reflectionErrorCode
 */

import { Code } from "@connectrpc/connect";

/** Smallest and largest gRPC status code that maps onto a Connect `Code`. */
const FIRST_CONNECT_CODE = Code.Canceled;
const LAST_CONNECT_CODE = Code.Unauthenticated;

export function reflectionErrorCode(errorCode: number): Code {
    return Number.isInteger(errorCode) && errorCode >= FIRST_CONNECT_CODE && errorCode <= LAST_CONNECT_CODE ? (errorCode as Code) : Code.Unknown;
}
