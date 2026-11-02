/**
 * Lifecycle logger of a server: the destination of the messages the library
 * itself writes (listening address, received signals, shutdown problems,
 * transport warnings).
 *
 * @module logger
 */

import type { ServerLogger } from "./types.ts";

/** Methods the server calls on its logger. */
const LOGGER_METHODS = ["info", "warn", "error"] as const;

/**
 * Check the `logger` option and return the logger the server writes to.
 *
 * Without the option the global `console` is used, as before the option
 * existed. The returned object is the caller's own, not a copy: its methods are
 * looked up on every call, so a logger that is reconfigured or replaced
 * method-by-method after `createServer()` (as test doubles do with `console`)
 * keeps working.
 *
 * @throws TypeError if `logger` is not an object, or lacks an `info`, `warn` or `error` function
 * @internal
 */
export function resolveLogger(logger: ServerLogger | undefined): ServerLogger {
    if (logger === undefined) {
        return console;
    }
    if (typeof logger !== "object" || logger === null) {
        throw new TypeError(`createServer: logger must be an object with info, warn and error methods, got ${logger === null ? "null" : typeof logger}`);
    }
    for (const method of LOGGER_METHODS) {
        const found: unknown = logger[method];
        if (typeof found !== "function") {
            throw new TypeError(`createServer: logger.${method} must be a function, got ${found === null ? "null" : typeof found}`);
        }
    }
    return logger;
}
