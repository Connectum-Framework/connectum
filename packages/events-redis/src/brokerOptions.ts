/**
 * Validation of the Redis broker tuning options.
 *
 * @module brokerOptions
 */

import type { RedisBrokerOptions } from "./types.ts";

function describeValue(value: unknown): string {
    if (typeof value === "number") {
        return String(value);
    }
    // A BigInt or a circular object makes JSON.stringify throw, and an object without a prototype makes
    // String() throw; the caller must still get the RangeError that names the option, so fall back step by step.
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        try {
            return String(value);
        } catch {
            return Object.prototype.toString.call(value);
        }
    }
}

function checkInteger(name: string, value: unknown, minimum: 0 | 1): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        const rule = minimum === 0 ? "a non-negative safe integer" : "a positive safe integer";
        throw new RangeError(`RedisAdapter: brokerOptions.${name} must be ${rule}, got ${describeValue(value)}`);
    }
}

/**
 * Reject broker options that Redis would accept silently or refuse on every call.
 *
 * Without the check `maxLen: 0` trims every published entry without an error, and an invalid
 * `blockMs` or `count` starts successfully and then fails every second inside the consume loop.
 *
 * @throws {RangeError} When `maxLen` or `count` is not a positive safe integer, or `blockMs` is not a non-negative safe integer.
 */
export function validateBrokerOptions(brokerOptions: RedisBrokerOptions | undefined): void {
    if (brokerOptions === undefined) {
        return;
    }
    checkInteger("maxLen", brokerOptions.maxLen, 1);
    checkInteger("blockMs", brokerOptions.blockMs, 0);
    checkInteger("count", brokerOptions.count, 1);
}
