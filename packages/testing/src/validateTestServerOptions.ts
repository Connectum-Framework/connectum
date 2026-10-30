/**
 * Runtime checks of the options of {@link createTestServer}, so that a value
 * that is not what the type says fails with a message naming the option and the
 * position, before anything is started, instead of with a `TypeError` from the
 * middle of `createServer`.
 *
 * @module validateTestServerOptions
 */

import type { CreateTestServerOptions } from "./types.ts";

function describeValue(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "an array";
    }
    return typeof value === "string" ? `the string ${JSON.stringify(value)}` : `a ${typeof value}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Check the options of `createTestServer()`.
 *
 * Validates the three lists whose element type the compiler cannot enforce at
 * the call boundary of untyped code: `services` (each element a service
 * definition, as `defineService()` and `defineLazyService()` return it),
 * `interceptors` (functions) and `protocols` (objects with a `name` and a
 * `register` function), `host` (a non-empty string) and the keys of `shutdown`.
 * `port` and the value of `shutdown.timeout` are checked by `createServer()`
 * itself.
 *
 * @throws TypeError naming the option, and the index of the offending element
 */
export function validateTestServerOptions(options: unknown): asserts options is CreateTestServerOptions {
    if (!isObject(options) || Array.isArray(options)) {
        throw new TypeError(`createTestServer: options must be an object like { services: [...] }, got ${describeValue(options)}.`);
    }

    const { services, interceptors, protocols, host, shutdown } = options;

    if (shutdown !== undefined) {
        if (!isObject(shutdown) || Array.isArray(shutdown)) {
            throw new TypeError(`createTestServer: shutdown must be an object like { timeout: 1000 }, got ${describeValue(shutdown)}.`);
        }
        // Only the timeout is passed on; any other key would be a setting that does nothing.
        for (const key of Object.keys(shutdown)) {
            if (key !== "timeout") {
                throw new TypeError(`createTestServer: shutdown.${key} is not supported; only shutdown.timeout is.`);
            }
        }
    }

    if (host !== undefined && (typeof host !== "string" || host === "")) {
        throw new TypeError(`createTestServer: host must be a non-empty string such as "127.0.0.1" or "0.0.0.0", got ${host === "" ? "an empty string" : describeValue(host)}.`);
    }

    if (!Array.isArray(services)) {
        throw new TypeError(`createTestServer: services must be an array of service definitions, got ${services === undefined ? "nothing" : describeValue(services)}.`);
    }
    services.forEach((service: unknown, index) => {
        if (!isObject(service) || !isObject(service.descriptor) || typeof service.register !== "function") {
            throw new TypeError(
                `createTestServer: services[${index}] must be a service definition returned by defineService() or defineLazyService(), got ${describeValue(service)}.`,
            );
        }
    });

    if (interceptors !== undefined) {
        if (!Array.isArray(interceptors)) {
            throw new TypeError(`createTestServer: interceptors must be an array of interceptor functions, got ${describeValue(interceptors)}.`);
        }
        interceptors.forEach((interceptor: unknown, index) => {
            if (typeof interceptor !== "function") {
                throw new TypeError(`createTestServer: interceptors[${index}] must be an interceptor function, got ${describeValue(interceptor)}.`);
            }
        });
    }

    if (protocols !== undefined) {
        if (!Array.isArray(protocols)) {
            throw new TypeError(`createTestServer: protocols must be an array of protocol registrations, got ${describeValue(protocols)}.`);
        }
        protocols.forEach((protocol: unknown, index) => {
            if (!isObject(protocol) || typeof protocol.name !== "string" || typeof protocol.register !== "function") {
                throw new TypeError(`createTestServer: protocols[${index}] must be a protocol registration with a name and a register() function, got ${describeValue(protocol)}.`);
            }
        });
    }
}
