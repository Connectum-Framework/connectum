/**
 * defineService — the canonical way to register a service on a Connectum server.
 *
 * A {@link ServiceDefinition} pairs a proto `DescService` descriptor with a
 * closure that mounts its handlers on a `ConnectRouter`. Keeping the descriptor
 * alongside the registration closure lets the framework build the service
 * catalog, drive `enabledServices` activation, and validate the transport
 * without re-deriving identity from the router.
 *
 * @module defineService
 */

import type { DescService } from "@bufbuild/protobuf";
import type { ConnectRouter, ServiceImpl } from "@connectrpc/connect";

/**
 * A service ready to be mounted: its proto descriptor plus a `register` closure
 * that wires the handlers onto a `ConnectRouter`. Produced by {@link defineService}
 * and {@link defineLazyService}; consumed by `createServer({ services })`.
 */
export interface ServiceDefinition {
    /** The proto service descriptor (carries `typeName` and `file`). */
    readonly descriptor: DescService;
    /** Mounts the service's handlers on the given router. @internal */
    readonly register: (router: ConnectRouter) => void;
}

/**
 * Define a service from its descriptor and handler map.
 *
 * @example
 * ```ts
 * const greeter = defineService(GreeterService, {
 *   async sayHello(req) { return { message: `Hello, ${req.name}!` }; },
 * });
 * createServer({ services: [greeter] });
 * ```
 */
export function defineService<S extends DescService>(descriptor: S, handlers: ServiceImpl<S>): ServiceDefinition {
    return {
        descriptor,
        register(router) {
            router.service(descriptor, handlers);
        },
    };
}

/**
 * Define a service whose handlers (and their dependencies) are created lazily.
 *
 * `factory` runs only when the service is actually mounted locally — i.e. when
 * it is in `enabledServices` (or `enabledServices` is `undefined`). A service
 * routed to a remote process never instantiates its local dependencies. Useful
 * for DI-heavy monoliths where wiring a service is expensive.
 */
export function defineLazyService<S extends DescService>(descriptor: S, factory: () => ServiceImpl<S>): ServiceDefinition {
    return {
        descriptor,
        register(router) {
            router.service(descriptor, factory());
        },
    };
}
