/**
 * Construction-time validation of `NatsAdapter` options.
 *
 * An option the adapter cannot honor must fail when the adapter is created and name the option, not
 * later at `connect()` or `subscribe()` with an error from the server, and never by silently acting as
 * some other value: `ackWait: 0` used to become the 30 s default, `deliverPolicy: "bogus"` used to
 * behave like `"new"`, and `servers: []` used to dial the local default address.
 *
 * @module validateOptions
 */

/** Milliseconds-to-nanoseconds multiplier; `ackWait` is given in milliseconds and sent to the server in nanoseconds. */
export const MS_TO_NS = 1_000_000;

/** Largest `ackWait` in milliseconds whose nanosecond value is still an exact integer in a JSON number. */
export const MAX_ACK_WAIT_MS = Math.floor(Number.MAX_SAFE_INTEGER / MS_TO_NS);

/** Smallest `ackWait` in milliseconds: one nanosecond. Anything shorter rounds to 0, which the server reads as "use the default". */
const MIN_ACK_WAIT_MS = 1 / MS_TO_NS;

/** The deliver policies the adapter maps to JetStream; anything else used to behave like `"new"`. */
export const DELIVER_POLICIES = ["new", "all", "last"] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An optional option that must be an object when present. */
function optionalObject(name: string, value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`NatsAdapter: ${name} must be an object, got ${show(value)}`);
    }
    return value;
}

/**
 * `servers` must name at least one server: a non-empty string, or a non-empty array of non-empty
 * strings. An empty array or an empty string made the client dial its local default address.
 */
function validateServers(servers: unknown): void {
    const message = `NatsAdapter: servers must be a non-empty string or a non-empty array of non-empty strings, got ${show(servers)}`;
    if (typeof servers === "string") {
        if (servers.trim() === "") {
            throw new RangeError(message);
        }
        return;
    }
    if (!Array.isArray(servers)) {
        throw new TypeError(message);
    }
    if (servers.length === 0) {
        throw new RangeError(message);
    }
    for (const [index, server] of servers.entries()) {
        if (typeof server !== "string") {
            throw new TypeError(`NatsAdapter: servers[${index}] must be a non-empty string, got ${show(server)}`);
        }
        if (server.trim() === "") {
            throw new RangeError(`NatsAdapter: servers[${index}] must be a non-empty string, got ${show(server)}`);
        }
    }
}

/**
 * An optional number of milliseconds within `[min, max]`; a non-number is a `TypeError`, a number
 * outside the range (`NaN` and the infinities included) a `RangeError`.
 */
function optionalMilliseconds(name: string, value: unknown, range: { readonly min: number; readonly max: number; readonly allowed: string }): void {
    if (value === undefined) {
        return;
    }
    const message = `NatsAdapter: ${name} must be ${range.allowed}, got ${show(value)}`;
    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
        throw new RangeError(message);
    }
}

/** Largest 32-bit signed integer: the bound for counts the client or a timer takes as an `int`. */
const MAX_INT32 = 2_147_483_647;

/** An optional integer within `[min, max]`; a non-number is a `TypeError`, a number outside the range (or a fraction) a `RangeError`. */
function optionalInteger(name: string, value: unknown, range: { readonly min: number; readonly max: number }): void {
    if (value === undefined) {
        return;
    }
    const message = `NatsAdapter: ${name} must be an integer from ${range.min} to ${range.max}, got ${show(value)}`;
    if (typeof value !== "number") {
        throw new TypeError(message);
    }
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new RangeError(message);
    }
}

/**
 * Reject options that cannot work, at construction. Values that passed before keep their meaning.
 *
 * @throws {TypeError} When an option has the wrong type or `deliverPolicy` names no policy.
 * @throws {RangeError} When a number or a list is outside what the server or the client honors.
 */
export function validateAdapterOptions(options: unknown): void {
    if (!isRecord(options)) {
        throw new TypeError(`NatsAdapter: options must be an object with servers, got ${show(options)}`);
    }

    validateServers(options.servers);

    const consumer = optionalObject("consumerOptions", options.consumerOptions);
    if (consumer === undefined) {
        return;
    }

    const { deliverPolicy, ackWait, maxDeliver } = consumer;
    if (deliverPolicy !== undefined && !(DELIVER_POLICIES as readonly unknown[]).includes(deliverPolicy)) {
        throw new TypeError(`NatsAdapter: consumerOptions.deliverPolicy must be one of ${DELIVER_POLICIES.map((policy) => `"${policy}"`).join(", ")}, got ${show(deliverPolicy)}`);
    }

    optionalMilliseconds("consumerOptions.ackWait", ackWait, {
        min: MIN_ACK_WAIT_MS,
        max: MAX_ACK_WAIT_MS,
        allowed: `a finite number of milliseconds greater than 0 and at most ${MAX_ACK_WAIT_MS}`,
    });

    optionalInteger("consumerOptions.prefetch", consumer.prefetch, { min: 1, max: MAX_INT32 });

    if (maxDeliver !== undefined) {
        const message = `NatsAdapter: consumerOptions.maxDeliver must be -1 (unlimited) or a positive integer, got ${show(maxDeliver)}`;
        if (typeof maxDeliver !== "number") {
            throw new TypeError(message);
        }
        if (!Number.isInteger(maxDeliver) || (maxDeliver !== -1 && maxDeliver < 1) || maxDeliver > Number.MAX_SAFE_INTEGER) {
            throw new RangeError(message);
        }
    }
}
