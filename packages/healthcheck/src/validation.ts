/**
 * Argument checks shared by the manager, the HTTP handler and `Healthcheck()`.
 *
 * Every check throws on the first problem, with a message that names the
 * offending option or argument and the value received, so a misuse fails where
 * it is made instead of on the first probe.
 *
 * @module @connectum/healthcheck/validation
 */

import { ServingStatus } from "./types.ts";

/** The status values a registry entry may hold. */
const SERVING_STATUS_VALUES: ReadonlySet<number> = new Set([ServingStatus.UNKNOWN, ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVICE_UNKNOWN]);

/** A received value as it reads in an error message, kept short. */
export function describeValue(value: unknown): string {
    if (typeof value === "string") {
        return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
    }
    if (typeof value === "object" && value !== null) {
        return Array.isArray(value) ? "array" : "object";
    }
    return String(value);
}

/**
 * Require one of the four `ServingStatus` numbers.
 *
 * @param status - Value to check
 * @param where - Caller prefix for the message, for example `HealthcheckManager.set()`
 * @throws {TypeError} when `status` is not a number
 * @throws {RangeError} when it is a number other than 0, 1, 2 or 3
 */
export function assertServingStatus(status: unknown, where: string): asserts status is ServingStatus {
    if (typeof status !== "number") {
        throw new TypeError(`${where}: status must be a ServingStatus number (0, 1, 2 or 3), got ${describeValue(status)}`);
    }
    if (!SERVING_STATUS_VALUES.has(status)) {
        throw new RangeError(`${where}: status must be a ServingStatus number (0, 1, 2 or 3), got ${describeValue(status)}`);
    }
}

/**
 * Require a string for a name argument (`component` or `service`).
 *
 * @throws {TypeError} when `value` is not a string
 */
export function assertName(value: unknown, argument: string, where: string): asserts value is string {
    if (typeof value !== "string") {
        throw new TypeError(`${where}: ${argument} must be a string, got ${describeValue(value)}`);
    }
}
