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
 * existed. The methods of the caller's logger are looked up on every call, so a
 * logger that is reconfigured or replaced method-by-method after
 * `createServer()` (as test doubles do with `console`) keeps working. A
 * throwing method is isolated (see {@link isolated}).
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
    return isolated(logger);
}

/**
 * Wrap the application's logger so that a method that throws cannot break the
 * lifecycle code that reports through it: a failing `info` would otherwise
 * escape the listen callback as an uncaught exception, and a failing `warn`
 * during shutdown would skip every shutdown hook. A message the logger could
 * not take has no other place to go, so the failure is dropped.
 */
function isolated(logger: ServerLogger): ServerLogger {
    const guard =
        (method: (typeof LOGGER_METHODS)[number]) =>
        (message: string, ...details: unknown[]): void => {
            try {
                // An async method is assignable to the `void` return type; its
                // rejection would otherwise surface as an unhandled rejection.
                const result: unknown = logger[method](message, ...details);
                if (result instanceof Promise) {
                    result.catch(() => {});
                }
            } catch {
                // nowhere left to report a failing logger
            }
        };
    return { info: guard("info"), warn: guard("warn"), error: guard("error") };
}
