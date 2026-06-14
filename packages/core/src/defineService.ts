/**
 * defineService — the canonical way to register a service on a Connectum server.
 *
 * A {@link ServiceDefinition} pairs a proto `DescService` descriptor with a
 * closure that mounts its handlers on a `ConnectRouter`. Keeping the descriptor
 * alongside the registration closure lets the framework build the service
 * catalog, drive `enabledServices` activation, and validate the transport
 * without re-deriving identity from the router.
 *
 * Handlers receive a Connectum {@link Context} (the raw ConnectRPC
 * `HandlerContext` plus the typed `ctx.call`). The framework supplies a
 * {@link RegisterContext} at mount time so the registration closure can wrap
 * the user handlers without `defineService` needing a server reference.
 *
 * @module defineService
 */

import type { DescService } from "@bufbuild/protobuf";
import type { ConnectRouter, ServiceImpl } from "@connectrpc/connect";
import type { ConnectumServiceImpl } from "./context.ts";

/**
 * Framework-supplied helpers handed to a {@link ServiceDefinition}'s `register`
 * closure at mount time. Currently exposes the handler wrapper that injects the
 * Connectum {@link Context}.
 *
 * @internal
 */
export interface RegisterContext {
    /**
     * Wrap a user service implementation so each method receives a Connectum
     * `Context` in place of the raw ConnectRPC `HandlerContext`.
     */
    readonly wrapHandlers: <S extends DescService>(descriptor: S, handlers: ConnectumServiceImpl<S>) => ServiceImpl<S>;
}

/**
 * A service ready to be mounted: its proto descriptor plus a `register` closure
 * that wires the handlers onto a `ConnectRouter`. Produced by {@link defineService}
 * and {@link defineLazyService}; consumed by `createServer({ services })`.
 */
export interface ServiceDefinition {
    /** The proto service descriptor (carries `typeName` and `file`). */
    readonly descriptor: DescService;
    /** Mounts the service's handlers on the given router. @internal */
    readonly register: (router: ConnectRouter, ctx: RegisterContext) => void;
}

/**
 * Define a service from its descriptor and handler map.
 *
 * @example
 * ```ts
 * const greeter = defineService(GreeterService, {
 *   async sayHello(req, ctx) {
 *     // ctx.call(...) is available for cross-service calls
 *     return { message: `Hello, ${req.name}!` };
 *   },
 * });
 * createServer({ services: [greeter] });
 * ```
 */
export function defineService<S extends DescService>(descriptor: S, handlers: ConnectumServiceImpl<S>): ServiceDefinition {
    return {
        descriptor,
        register(router, ctx) {
            router.service(descriptor, ctx.wrapHandlers(descriptor, handlers));
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
export function defineLazyService<S extends DescService>(descriptor: S, factory: () => ConnectumServiceImpl<S>): ServiceDefinition {
    return {
        descriptor,
        register(router, ctx) {
            router.service(descriptor, ctx.wrapHandlers(descriptor, factory()));
        },
    };
}
