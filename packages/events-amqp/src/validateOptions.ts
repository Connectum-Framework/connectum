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
