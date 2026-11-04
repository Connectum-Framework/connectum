/**
 * Argument checks shared by the fixture factories.
 *
 * A fixture that is given a value it cannot honour throws at creation, naming the
 * argument and the accepted values, instead of quietly building something else.
 *
 * @module
 */

/**
 * The four kinds of an RPC method, as `DescMethod.methodKind` reports them.
 *
 * @internal
 */
export const METHOD_KINDS = ["unary", "server_streaming", "client_streaming", "bidi_streaming"] as const;

/**
 * Longest delay `setTimeout` honours (2^31 - 1 ms). A larger value is turned into 1 ms.
 *
 * @internal
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Check that a method kind is one of {@link METHOD_KINDS}.
 *
 * @internal
 */
export function assertMethodKind(kind: unknown, context: string): void {
    if (typeof kind !== "string" || !(METHOD_KINDS as readonly string[]).includes(kind)) {
        throw new TypeError(`${context}: unknown method kind ${JSON.stringify(kind) ?? String(kind)}; expected one of: ${METHOD_KINDS.join(", ")}`);
    }
}

/**
 * Check that a delay is a number `setTimeout` can honour: finite, not negative and at
 * most 2^31 - 1 milliseconds. Anything else is turned into 1 ms by the timer.
 *
 * @internal
 */
export function assertTimerDelay(delay: unknown, context: string): void {
    if (typeof delay !== "number") {
        throw new TypeError(`${context} must be a number of milliseconds, got ${typeof delay === "object" ? String(delay) : `${typeof delay} ${JSON.stringify(delay)}`}`);
    }
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`${context} must be a finite number of milliseconds between 0 and ${MAX_TIMER_DELAY_MS}, got ${delay}`);
    }
}
