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
import { assertBooleanOption, assertHttpPaths, assertManager, assertOptionsObject, assertWatchInterval } from "./validation.ts";

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
 * @throws {RangeError} when `httpPaths` is an empty array, or `watchInterval`
 *   is a number that is not an integer from 1 to 2147483647
 * @throws {TypeError} when `options` is not an object (`null` included),
 *   `manager` is not a HealthcheckManager, `httpEnabled` is not a boolean,
 *   `httpPaths` is not an array, or an entry is not a string, does not start
 *   with `/`, or contains `?` or `#`; or when `watchInterval` is not a number
 *   (including `null`)
 *
 * A second `Healthcheck()` in one server (or an application service that
 * already is `grpc.health.v1.Health`) cannot be seen from here. It is refused
 * with an `Error` when the server builds its routes: `start()` rejects, and so
 * does the first `localClient()`.
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
    assertOptionsObject(options);
    const { httpEnabled = false, httpPaths, watchInterval = DEFAULT_WATCH_INTERVAL } = options;
    // Only an omitted manager selects the singleton; null is a mistake.
    const manager = options.manager === undefined ? healthcheckManager : options.manager;

    assertBooleanOption(httpEnabled, "httpEnabled");
    assertManager(manager);
    assertWatchInterval(watchInterval);

    if (httpPaths !== undefined) {
        assertHttpPaths(httpPaths, "Healthcheck(): option 'httpPaths'", "to disable the HTTP endpoint set 'httpEnabled: false'");
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
            // `context.services` includes those of the protocols before this
            // one, so a second Healthcheck() (or an application that mounts its
            // own Health service) shows up here. Two answers for one service
            // would silently ignore one of the managers.
            if (context.services.some((service) => service.typeName === Health.typeName)) {
                throw new Error(
                    `Healthcheck(): the '${Health.typeName}' service is already registered by the application or by an earlier Healthcheck(); register Healthcheck() once per server`,
                );
            }
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
