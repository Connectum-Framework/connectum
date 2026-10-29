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

import { Code } from "@connectrpc/connect";

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
 * Require an options argument to be an object. `null`, numbers, strings, arrays and
 * functions are refused: destructuring them would either throw a raw `TypeError` that
 * does not name the factory or, for a string or an array, silently read nothing.
 *
 * @param options.caller - factory name shown in the message
 * @param options.value - the received argument
 * @param options.name - what the argument is called in the message; `"options"` by default
 * @throws TypeError if `value` is not an object
 */
export function requireOptionsObject(options: { caller: string; value: unknown; name?: string }): void {
    const { caller, value, name = "options" } = options;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${caller}: ${name} must be an object, got ${describeValue(value)}`);
    }
}

/**
 * Require a value to be an array whose entries are all functions. An entry that is
 * `null`, `undefined` or anything else is refused instead of being skipped, so a
 * missing interceptor cannot go unnoticed.
 *
 * @param options.caller - factory name shown in the message
 * @param options.subject - what the array is, e.g. `the interceptors of "svc/*"`
 * @param options.value - the received value
 * @throws TypeError if `value` is not an array, or an entry is not a function
 */
export function requireFunctionArray(options: { caller: string; subject: string; value: unknown }): void {
    const { caller, subject, value } = options;
    if (!Array.isArray(value)) {
        throw new TypeError(`${caller}: ${subject} must be an array of functions, got ${describeValue(value)}`);
    }
    // An index loop, not forEach: forEach skips the holes of a sparse array.
    for (let index = 0; index < value.length; index++) {
        const entry: unknown = value[index];
        if (typeof entry !== "function") {
            throw new TypeError(`${caller}: entry ${index} of ${subject} must be a function, got ${describeValue(entry)}`);
        }
    }
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

/**
 * Require every own enumerable key of an options object to be one the factory
 * knows. A mistyped key is otherwise ignored, so the caller asks for a behavior
 * (a timeout, say) and silently gets none. A key whose value is `undefined` still
 * counts: its name is wrong whatever it holds.
 *
 * @param options.caller - factory name shown in the message
 * @param options.value - the received options object
 * @param options.known - every key the factory accepts, in the order to list them
 * @throws TypeError naming every unknown key and listing the known ones
 */
export function requireKnownKeys(options: { caller: string; value: object; known: readonly string[] }): void {
    const { caller, value, known } = options;
    const unknown = Object.keys(value).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
        const names = unknown.map((key) => JSON.stringify(key)).join(", ");
        throw new TypeError(`${caller}: unknown option${unknown.length > 1 ? "s" : ""} ${names}; the known options are ${known.join(", ")}`);
    }
}

/**
 * Require an option to be a boolean. Truthy and falsy values of other types are
 * refused: `"no"` or `"yes"` would otherwise be read as `true`, `0` or `null` as `false`.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @throws TypeError if `value` is not a boolean
 */
export function requireBoolean(options: { caller: string; option: string; value: unknown }): void {
    const { caller, option, value } = options;
    if (typeof value !== "boolean") {
        throw new TypeError(`${caller}: ${option} must be true or false, got ${describeValue(value)}`);
    }
}

/**
 * Require an option to be a function.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @throws TypeError if `value` is not a function
 */
export function requireFunction(options: { caller: string; option: string; value: unknown }): void {
    const { caller, option, value } = options;
    if (typeof value !== "function") {
        throw new TypeError(`${caller}: ${option} must be a function, got ${describeValue(value)}`);
    }
}

/**
 * Require an option to be one of a fixed list of strings.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @param options.allowed - the accepted strings
 * @throws TypeError if `value` is not a string
 * @throws RangeError if `value` is a string outside the list
 */
export function requireOneOf(options: { caller: string; option: string; value: unknown; allowed: readonly string[] }): void {
    const { caller, option, value, allowed } = options;
    const message = `${caller}: ${option} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}, got ${describeValue(value)}`;
    if (typeof value !== "string") {
        throw new TypeError(message);
    }
    if (!allowed.includes(value)) {
        throw new RangeError(message);
    }
}

/**
 * Require an option to be an array of Connect status codes (`Code.Unavailable` and
 * the like). A string such as `"14"`, a bare number or `null` would otherwise be
 * accepted and make the interceptor retry nothing, or fail on its first failing call.
 *
 * @param options.caller - factory name shown in the message
 * @param options.option - option name shown in the message
 * @param options.value - the received value
 * @throws TypeError if `value` is not an array, or an entry is not a number
 * @throws RangeError if an entry is a number that is not a Connect code
 */
export function requireConnectCodes(options: { caller: string; option: string; value: unknown }): void {
    const { caller, option, value } = options;
    if (!Array.isArray(value)) {
        throw new TypeError(`${caller}: ${option} must be an array of Connect codes, got ${describeValue(value)}`);
    }
    // An index loop, not forEach: forEach skips the holes of a sparse array.
    for (let index = 0; index < value.length; index++) {
        const entry: unknown = value[index];
        if (typeof entry !== "number") {
            throw new TypeError(`${caller}: entry ${index} of ${option} must be a Connect code, got ${describeValue(entry)}`);
        }
        if (typeof Code[entry] !== "string") {
            throw new RangeError(`${caller}: entry ${index} of ${option} must be a Connect code from 1 to 16, got ${describeValue(entry)}`);
        }
    }
}
