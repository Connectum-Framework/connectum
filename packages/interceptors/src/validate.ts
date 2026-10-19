/**
 * Option validation shared by the interceptor factories
 *
 * Internal: not exported from the package entry point. A wrong option is refused
 * when the factory is called, so a misconfiguration surfaces at startup instead of
 * as a silently different behaviour under load.
 *
 * Error class by cause: a value that is not of the expected type is a
 * `TypeError`; a value of the right type that violates the rule (NaN, Infinity,
 * a fraction where an integer is required, outside the range) is a `RangeError`.
 *
 * @module validate
 */

/**
 * Largest delay in milliseconds the Node.js timer honours. A longer delay does not
 * wait longer: the runtime fires the timer after 1 ms, so a "very long" timeout
 * would turn into an immediate expiry. Every millisecond option is capped here.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** Render a received value for an error message without throwing on exotic values. */
function describeValue(value: unknown): string {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "an array";
    }
    if (typeof value === "function") {
        return "a function";
    }
    if (typeof value === "object" && value !== null) {
        return "an object";
    }
    if (typeof value === "bigint") {
        return `${value}n`;
    }
    return String(value);
}

/**
 * Require a number option to be an integer inside an inclusive range.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @param options.min - smallest accepted value
 * @param options.max - largest accepted value; unbounded when omitted
 * @param options.unit - unit appended to the range, e.g. `"milliseconds"`
 * @throws TypeError if `value` is not a number
 * @throws RangeError if `value` is not an integer in the range
 */
export function requireInteger(options: { caller: string; option: string; value: unknown; min: number; max?: number; unit?: string }): void {
    const { caller, option, value, min, max, unit } = options;
    const suffix = unit === undefined ? "" : ` ${unit}`;
    const rule = max === undefined ? `an integer of at least ${min}${suffix}` : `an integer from ${min} to ${max}${suffix}`;
    const message = `${caller}: ${option} must be ${rule}, got ${describeValue(value)}`;

    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
        throw new RangeError(message);
    }
}

/**
 * Require a number option to be finite and not below a minimum; fractions are allowed.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @param options.min - smallest accepted value
 * @throws TypeError if `value` is not a number
 * @throws RangeError if `value` is NaN, infinite or below `min`
 */
export function requireFiniteNumber(options: { caller: string; option: string; value: unknown; min: number }): void {
    const { caller, option, value, min } = options;
    const message = `${caller}: ${option} must be a finite number of at least ${min}, got ${describeValue(value)}`;

    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isFinite(value) || value < min) {
        throw new RangeError(message);
    }
}

/**
 * Shapes a key of `createDefaultInterceptors` options may take:
 * - `toggle`: `true`, `false`, `undefined` or an options object
 * - `fallback`: `false`, `undefined` or an options object (it has no default handler, so `true` means nothing)
 * - `boolean`: `true`, `false` or `undefined`
 */
export type DefaultOptionKind = "toggle" | "fallback" | "boolean";

const EXPECTATION: Record<DefaultOptionKind, string> = {
    toggle: "true, false or an options object",
    fallback: "false or an options object with a handler",
    boolean: "true or false",
};

/**
 * Require a `createDefaultInterceptors` key to hold one of the values its kind allows.
 * `null`, numbers, strings, arrays and functions are refused for every key: a value
 * that is not understood must not silently disable the interceptor.
 *
 * @param options.option - key name shown in the message
 * @param options.value - the received value
 * @param options.kind - which shape the key accepts
 * @throws TypeError naming the key if the value is not allowed
 */
export function requireDefaultOption(options: { option: string; value: unknown; kind: DefaultOptionKind }): void {
    const { option, value, kind } = options;
    if (value === undefined || value === false) {
        return;
    }
    if (value === true) {
        if (kind === "fallback") {
            throw new TypeError(`${option} must be ${EXPECTATION[kind]}, got true`);
        }
        return;
    }
    if (kind !== "boolean" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        return;
    }
    throw new TypeError(`${option} must be ${EXPECTATION[kind]}, got ${describeValue(value)}`);
}
