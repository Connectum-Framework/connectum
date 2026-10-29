/**
 * Healthcheck protocol registration factory
 *
 * Creates a ProtocolRegistration for the gRPC Health Check protocol.
 * Uses module-level singleton `healthcheckManager` for status management,
 * importable from any file in the application.
 *
 * @module @connectum/healthcheck/Healthcheck
 */

import { setTimeout } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ProtocolContext, ProtocolRegistration } from "@connectum/core";
import { Health, HealthCheckResponseSchema, HealthListResponseSchema } from "#gen/grpc/health/v1/health_pb.js";
import { HealthcheckManager } from "./HealthcheckManager.ts";
import { createHttpHealthHandler } from "./httpHandler.ts";
import type { HealthcheckOptions } from "./types.ts";
import { ServingStatus } from "./types.ts";

/**
 * Default watch interval for streaming health updates (ms)
 */
const DEFAULT_WATCH_INTERVAL = 500;

/**
 * Module-level singleton health manager
 *
 * Importable from any file to update service health status.
 *
 * @example
 * ```typescript
 * import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * healthcheckManager.update(ServingStatus.SERVING);
 * healthcheckManager.update(ServingStatus.NOT_SERVING, 'my.service.v1.MyService');
 * ```
 */
export const healthcheckManager = new HealthcheckManager();

/**
 * Resolve effective serving status for a service
 *
 * Empty service name checks overall health (all services).
 * Unknown service name returns SERVICE_UNKNOWN per gRPC spec.
 */
function resolveServiceStatus(manager: HealthcheckManager, service: string): ServingStatus {
    if (service === "") {
        return manager.areAllHealthy() ? ServingStatus.SERVING : ServingStatus.NOT_SERVING;
    }
    const serviceStatus = manager.getStatus(service);
    return serviceStatus ? serviceStatus.status : ServingStatus.SERVICE_UNKNOWN;
}

/**
 * Longest part of a requested service name that an error message repeats.
 * The name comes from the client without a limit of its own: echoing all of it
 * lets one request build a response larger than an HTTP/2 frame, which kills
 * the stream and can take the session down with it.
 */
const MAX_ECHOED_NAME_LENGTH = 128;

/**
 * Cut a client-supplied name to {@link MAX_ECHOED_NAME_LENGTH} UTF-16 code
 * units for use in a message, marking the cut with an ellipsis. A name that
 * fits is returned unchanged. A cut never leaves half of a surrogate pair.
 */
function boundedName(name: string): string {
    if (name.length <= MAX_ECHOED_NAME_LENGTH) {
        return name;
    }
    let end = MAX_ECHOED_NAME_LENGTH;
    const last = name.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
    }
    return `${name.slice(0, end)}…`;
}

/**
 * Reject an `httpPaths` value that could never match a request or would
 * silently turn the HTTP endpoint into a no-op.
 *
 * A request path always starts with "/" and never contains the query or
 * fragment delimiters, so an element lacking the slash or containing them can
 * never be matched. An empty array would leave `httpEnabled: true` with no
 * reachable endpoint.
 */
function validateHttpPaths(httpPaths: unknown): void {
    if (!Array.isArray(httpPaths)) {
        throw new TypeError(`Healthcheck(): option 'httpPaths' must be an array of paths, got ${typeof httpPaths}`);
    }
    if (httpPaths.length === 0) {
        throw new RangeError("Healthcheck(): option 'httpPaths' must not be empty; to disable the HTTP endpoint set 'httpEnabled: false'");
    }
    for (const path of httpPaths as unknown[]) {
        if (typeof path !== "string") {
            throw new TypeError(`Healthcheck(): option 'httpPaths' must contain only strings, got ${typeof path}`);
        }
        if (!path.startsWith("/")) {
            throw new TypeError(`Healthcheck(): option 'httpPaths' entry '${path}' must start with '/'`);
        }
        if (path.includes("?") || path.includes("#")) {
            throw new TypeError(`Healthcheck(): option 'httpPaths' entry '${path}' must not contain '?' or '#'`);
        }
    }
}

/**
 * Create healthcheck protocol registration
 *
 * Returns a ProtocolRegistration directly (not `{ protocol, manager }`).
 * Pass to createServer({ protocols: [...] }).
 * Use the singleton `healthcheckManager` export to control health status.
 *
 * `httpPaths`, when passed, is validated even if `httpEnabled` is false.
 * HTTP request paths are matched exactly and case-sensitively (`/healthz/`
 * does not match `/healthz`); the query string is ignored and the method is
 * not checked.
 *
 * @param options - Healthcheck configuration options
 * @returns ProtocolRegistration for createServer
 * @throws {RangeError} when `httpPaths` is an empty array
 * @throws {TypeError} when `httpPaths` is not an array, or an entry is not a
 *   string, does not start with `/`, or contains `?` or `#`
 *
 * @example
 * ```typescript
 * import { createServer } from '@connectum/core';
 * import { Healthcheck, healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * const server = createServer({
 *   services: [myRoutes],
 *   protocols: [Healthcheck({ httpEnabled: true })],
 * });
 *
 * server.on('ready', () => {
 *   healthcheckManager.update(ServingStatus.SERVING);
 * });
 *
 * await server.start();
 * ```
 */
export function Healthcheck(options: HealthcheckOptions = {}): ProtocolRegistration {
    const { httpEnabled = false, httpPaths, watchInterval = DEFAULT_WATCH_INTERVAL } = options;
    const manager = options.manager ?? healthcheckManager;

    if (httpPaths !== undefined) {
        validateHttpPaths(httpPaths);
    }

    const protocol: ProtocolRegistration = {
        name: "healthcheck",

        // In setup, not register: a router built later sees mounted services that
        // already include this protocol's own Health service, so initializing
        // there would start tracking it as UNKNOWN and take overall health out
        // of SERVING. It would also drop any service the application tracks
        // without mounting it, because initialize keeps only the services in its
        // input (with their status) and removes the rest.
        setup(context: ProtocolContext): void {
            // The mounted services, not every service of their files.
            const serviceNames = context.services.map((service) => service.typeName);
            manager.initialize(serviceNames);
        },

        register(router: ConnectRouter): void {
            router.service(Health, {
                /**
                 * List all services with their health status
                 */
                list: () => {
                    const statuses = Object.fromEntries(manager.getAllStatuses().entries());

                    return create(HealthListResponseSchema, {
                        statuses,
                    });
                },

                /**
                 * Check health status of a specific service
                 *
                 * Per gRPC spec: returns NOT_FOUND for unknown services. The
                 * message repeats at most the first 128 characters of the name.
                 */
                check: ({ service }) => {
                    const status = resolveServiceStatus(manager, service);
                    if (status === ServingStatus.SERVICE_UNKNOWN) {
                        throw new ConnectError(`Service '${boundedName(service)}' not found`, Code.NotFound);
                    }
                    return create(HealthCheckResponseSchema, { status });
                },

                /**
                 * Watch health status changes (streaming)
                 *
                 * Per gRPC spec:
                 * - Sends initial status immediately
                 * - Sends updates only when status changes
                 * - For unknown services: sends SERVICE_UNKNOWN (does not terminate the call)
                 * - Terminates when client disconnects (AbortSignal)
                 */
                async *watch({ service }, context) {
                    let currentStatus = resolveServiceStatus(manager, service);

                    yield create(HealthCheckResponseSchema, { status: currentStatus });

                    while (!context.signal.aborted) {
                        try {
                            await setTimeout(watchInterval, undefined, { signal: context.signal });
                        } catch (err) {
                            if (err instanceof Error && err.name === "AbortError") {
                                break;
                            }
                            throw err;
                        }

                        const newStatus = resolveServiceStatus(manager, service);
                        if (newStatus !== currentStatus) {
                            currentStatus = newStatus;
                            yield create(HealthCheckResponseSchema, { status: currentStatus });
                        }
                    }
                },
            });
        },
    };

    if (httpEnabled) {
        protocol.httpHandler = createHttpHealthHandler(manager, httpPaths);
    }

    return protocol;
}
