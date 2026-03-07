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
import type { EventRouteEntry, EventRouter, ServiceEventHandlers, TypedEventHandler } from "./types.ts";

/**
 * EventRouter implementation that collects route entries.
 */
export class EventRouterImpl implements EventRouter {
    readonly entries: EventRouteEntry[] = [];

    service<S extends DescService>(serviceDesc: S, handlers: ServiceEventHandlers<S>): void {
        for (const method of serviceDesc.methods) {
            const handlerFn = (handlers as Record<string, TypedEventHandler<unknown>>)[method.localName];
            if (!handlerFn) {
                throw new Error(`Missing event handler for method "${method.localName}" in service "${serviceDesc.typeName}"`);
            }

            const topic = resolveTopicName(method);
            this.entries.push({
                topic,
                method,
                handler: handlerFn,
            });
        }
    }
}
