/**
 * Construction-time validation of `AmqpAdapter` options.
 *
 * An option the adapter cannot honor must fail when the adapter is created and
 * name the option, not later at `connect()` or `subscribe()` with an error from
 * the broker or amqplib, and never by silently acting as some other value.
 *
 * @module validateOptions
 */

import { AmqpTopologyMode } from "./types.ts";

/** A value as it appears in an error message: strings are quoted, objects named by type. */
function show(value: unknown): string {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "object" && value !== null) {
        return Array.isArray(value) ? "an array" : "an object";
    }
    return String(value);
}

/**
 * `topologyMode` must be one of `assert`, `check` or `skip`.
 *
 * Anything else used to fall into the assert path, so an operator who meant
 * `check` or `skip` (a different casing, a typo) got exchanges and queues
 * declared by the service. `undefined` keeps the default.
 */
export function validateTopologyMode(topologyMode: unknown): void {
    if (topologyMode === undefined) {
        return;
    }
    const allowed: readonly string[] = Object.values(AmqpTopologyMode);
    if (typeof topologyMode !== "string" || !allowed.includes(topologyMode)) {
        throw new TypeError(`AmqpAdapter: topologyMode must be one of ${allowed.map((mode) => `"${mode}"`).join(", ")}, got ${show(topologyMode)}`);
    }
}

/** Exchange types the adapter's routing logic is written for. */
const EXCHANGE_TYPES: readonly string[] = ["topic", "direct", "fanout", "headers"];

/** Largest value of the AMQP `prefetch-count` field (a 16-bit unsigned integer). */
const MAX_PREFETCH = 65_535;

/** Largest delay `setTimeout` honors; a larger one fires after about 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An option that is a boolean or an object of tuning knobs (`recovery`, `publishRetry`). */
function requireBooleanOrObject(name: string, value: unknown): Record<string, unknown> | undefined {
    if (value === undefined || typeof value === "boolean") {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`AmqpAdapter: ${name} must be a boolean or an object, got ${show(value)}`);
    }
    return value;
}

/** An optional option that must be an object when present. */
function optionalObject(name: string, value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`AmqpAdapter: ${name} must be an object, got ${show(value)}`);
    }
    return value;
}

/** An optional integer within `[min, max]`; a non-number is a `TypeError`, a number outside the range a `RangeError`. */
function optionalInteger(name: string, value: unknown, range: { readonly min: number; readonly max: number }): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number") {
        throw new TypeError(`AmqpAdapter: ${name} must be a number, got ${show(value)}`);
    }
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new RangeError(`AmqpAdapter: ${name} must be an integer from ${range.min} to ${range.max}, got ${show(value)}`);
    }
}

/** A delay in milliseconds a timer can honor: finite, not negative, at most the largest `setTimeout` delay. */
function optionalDelay(name: string, value: unknown): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number") {
        throw new TypeError(`AmqpAdapter: ${name} must be a number of milliseconds, got ${show(value)}`);
    }
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`AmqpAdapter: ${name} must be a finite number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS}, got ${show(value)}`);
    }
}

/** A jitter factor is a fraction of the delay, so it lies in `[0, 1]`; amqplib would clamp anything else without a word. */
function optionalJitter(name: string, value: unknown): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number") {
        throw new TypeError(`AmqpAdapter: ${name} must be a number, got ${show(value)}`);
    }
    if (!(value >= 0 && value <= 1)) {
        throw new RangeError(`AmqpAdapter: ${name} must be a number from 0 to 1, got ${show(value)}`);
    }
}

function optionalFunction(name: string, value: unknown): void {
    if (value !== undefined && typeof value !== "function") {
        throw new TypeError(`AmqpAdapter: ${name} must be a function, got ${show(value)}`);
    }
}

/**
 * Reject options that cannot work, at construction.
 *
 * Only values with no documented fallback are rejected. The documented
 * tolerances stay as they are: `publishTimeoutMs` and
 * `recovery.initialConnectMaxRetries` normalize a non-finite or out-of-range
 * number, `maxRetries` clamps a negative or fractional number.
 */
export function validateAdapterOptions(options: unknown): void {
    if (!isRecord(options)) {
        throw new TypeError(`AmqpAdapter: options must be an object with a url, got ${show(options)}`);
    }

    const { exchangeType, recovery, publishRetry, consumerOptions, queueOptions, serialization } = options;

    if (exchangeType !== undefined && (typeof exchangeType !== "string" || !EXCHANGE_TYPES.includes(exchangeType))) {
        throw new TypeError(`AmqpAdapter: exchangeType must be one of ${EXCHANGE_TYPES.map((type) => `"${type}"`).join(", ")}, got ${show(exchangeType)}`);
    }
    validateTopologyMode(options.topologyMode);

    optionalJitter("recovery.jitter", requireBooleanOrObject("recovery", recovery)?.jitter);

    const retry = requireBooleanOrObject("publishRetry", publishRetry);
    optionalJitter("publishRetry.jitter", retry?.jitter);
    if (retry?.maxRetries !== undefined && typeof retry.maxRetries !== "number") {
        throw new TypeError(`AmqpAdapter: publishRetry.maxRetries must be a number, got ${show(retry.maxRetries)}`);
    }

    const consumer = optionalObject("consumerOptions", consumerOptions);
    optionalInteger("consumerOptions.prefetch", consumer?.prefetch, { min: 0, max: MAX_PREFETCH });
    optionalDelay("consumerOptions.redeliveryDelay", consumer?.redeliveryDelay);

    const queue = optionalObject("queueOptions", queueOptions);
    optionalInteger("queueOptions.messageTtl", queue?.messageTtl, { min: 0, max: Number.MAX_SAFE_INTEGER });
    optionalInteger("queueOptions.maxLength", queue?.maxLength, { min: 0, max: Number.MAX_SAFE_INTEGER });

    const serializer = optionalObject("serialization", serialization);
    optionalFunction("serialization.encode", serializer?.encode);
    optionalFunction("serialization.decode", serializer?.decode);
    if (serializer?.contentType !== undefined && typeof serializer.contentType !== "string") {
        throw new TypeError(`AmqpAdapter: serialization.contentType must be a string, got ${show(serializer.contentType)}`);
    }
}
