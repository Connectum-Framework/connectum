/**
 * Construction-time checks of middleware and bus options.
 *
 * Every check throws a `TypeError` (wrong type) or a `RangeError` (right type, unusable value)
 * whose message starts with the factory that was called, names the option, says what is allowed
 * and shows what was received. A value that passes keeps its meaning; nothing here rewrites it.
 *
 * @module optionValidation
 */

/**
 * Show a received value in an error message. Strings are quoted so that `"3"` is not mistaken for
 * the number 3. A value whose conversion throws still gets a message, because the caller must see
 * the error that names the option, not the failure of the formatting.
 */
export function describeValue(value: unknown): string {
    try {
        return typeof value === "string" ? JSON.stringify(value) : String(value);
    } catch {
        return `a value of type ${typeof value}`;
    }
}

/**
 * The longest delay a Node.js timer keeps: a larger one is replaced by 1 ms with a
 * `TimeoutOverflowWarning`, which turns a long wait into a busy loop.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Refuse a number option outside `[min, max]`. `allowed` finishes the sentence "<name> must be ...".
 *
 * @throws {TypeError} When the value is not a number.
 * @throws {RangeError} When it is `NaN`, infinite, fractional where `integer` is set, or outside the range.
 */
export function assertNumberOption(options: {
    readonly owner: string;
    readonly name: string;
    readonly value: unknown;
    readonly min: number;
    readonly max: number;
    readonly integer?: boolean;
    readonly allowed: string;
}): void {
    const { owner, name, value, min, max, integer = false, allowed } = options;
    const message = `${owner}: ${name} must be ${allowed}, got ${describeValue(value)}`;
    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new RangeError(message);
    }
}

/**
 * Refuse a string option that is not usable as a name: it must be a string with a visible character.
 *
 * @throws {TypeError} When the value is not a string.
 * @throws {RangeError} When the string is empty or only whitespace.
 */
export function assertNonEmptyString(options: { readonly owner: string; readonly name: string; readonly value: unknown }): void {
    const { owner, name, value } = options;
    const message = `${owner}: ${name} must be a non-empty string, got ${describeValue(value)}`;
    if (typeof value !== "string") {
        throw new TypeError(message);
    }
    if (value.trim() === "") {
        throw new RangeError(message);
    }
}
