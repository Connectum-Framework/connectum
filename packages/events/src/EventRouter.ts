/**
 * EventRouter implementation.
 *
 * Mirrors ConnectRPC's ConnectRouter pattern for event handlers.
 * Iterates service methods, resolves topics, creates entries.
 *
 * @module EventRouter
 */

import type { DescService } from "@bufbuild/protobuf";
import { resolveTopicName } from "./topic.ts";
import type { EventHandlerConfig, EventMiddleware, EventRouteEntry, EventRouter, ServiceEventHandlers, TypedEventHandler } from "./types.ts";

/**
 * EventRouter implementation that collects route entries.
 */
export class EventRouterImpl implements EventRouter {
    readonly entries: EventRouteEntry[] = [];
    readonly serviceNames: string[] = [];

    service<S extends DescService>(serviceDesc: S, handlers: ServiceEventHandlers<S>): void {
        this.serviceNames.push(serviceDesc.typeName);
        for (const method of serviceDesc.methods) {
            const handlerOrConfig = (handlers as Record<string, TypedEventHandler<unknown> | EventHandlerConfig<unknown>>)[method.localName];
            if (!handlerOrConfig) {
                throw new Error(`Missing event handler for method "${method.localName}" in service "${serviceDesc.typeName}"`);
            }

            let handler: TypedEventHandler<unknown>;
            let perHandlerMiddleware: EventMiddleware[] | undefined;

            if (typeof handlerOrConfig === "function") {
                handler = handlerOrConfig;
            } else {
                handler = handlerOrConfig.handler;
                perHandlerMiddleware = handlerOrConfig.middleware;
            }

            const topic = resolveTopicName(method);
            const entry: EventRouteEntry = perHandlerMiddleware !== undefined ? { topic, method, handler, middleware: perHandlerMiddleware } : { topic, method, handler };
            this.entries.push(entry);
        }
    }
}
