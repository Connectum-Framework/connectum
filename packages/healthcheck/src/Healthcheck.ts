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
 * Create healthcheck protocol registration
 *
 * Returns a ProtocolRegistration directly (not `{ protocol, manager }`).
 * Pass to createServer({ protocols: [...] }).
 * Use the singleton `healthcheckManager` export to control health status.
 *
 * @param options - Healthcheck configuration options
 * @returns ProtocolRegistration for createServer
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

    const protocol: ProtocolRegistration = {
        name: "healthcheck",

        register(router: ConnectRouter, context: ProtocolContext): void {
            const serviceNames = context.registry.flatMap((file) => file.services.map((s) => s.typeName));
            manager.initialize(serviceNames);

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
                 * Per gRPC spec: returns NOT_FOUND for unknown services.
                 */
                check: ({ service }) => {
                    const status = resolveServiceStatus(manager, service);
                    if (status === ServingStatus.SERVICE_UNKNOWN) {
                        throw new ConnectError(`Service '${service}' not found`, Code.NotFound);
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
