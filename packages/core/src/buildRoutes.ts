/**
 * Route builder
 *
 * Composes services, protocols, and interceptors into a ConnectRPC handler.
 * Collects service DescFile registry for protocol use (reflection, etc).
 *
 * @module buildRoutes
 */

import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import type { DescFile } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ProtocolContext, ProtocolRegistration, ServiceRoute } from "./types.ts";

/**
 * Options for building routes
 */
export interface BuildRoutesOptions {
    services: ServiceRoute[];
    protocols: ProtocolRegistration[];
    interceptors: Interceptor[];
    shutdownSignal: AbortSignal;
}

/**
 * Result of building routes
 */
export interface BuildRoutesResult {
    handler: (req: Http2ServerRequest, res: Http2ServerResponse) => void;
    registry: DescFile[];
}

/**
 * Compose services, protocols, and interceptors into a ConnectRPC request handler.
 *
 * Intercepts `router.service()` calls to collect DescFile descriptors into a registry,
 * then registers user services and protocol services, and finally creates the
 * connectNodeAdapter with fallback routing to protocol HTTP handlers.
 *
 * @param options - Services, protocols, interceptors, and shutdown signal
 * @returns The HTTP handler and collected DescFile registry
 */
export function buildRoutes(options: BuildRoutesOptions): BuildRoutesResult {
    const { services, protocols, interceptors, shutdownSignal } = options;

    const registry: DescFile[] = [];

    // Setup routes with registry interceptor
    const routes = (router: ConnectRouter) => {
        // Intercept router.service() to collect DescFile[]
        const originalService = router.service;
        router.service = ((...args: Parameters<ConnectRouter["service"]>) => {
            const [service] = args;
            registry.push(service.file);
            return originalService.apply(router, args);
        }) as typeof originalService;

        // Register user services
        for (const serviceRoute of services) {
            serviceRoute(router);
        }

        // Register protocols
        const context: ProtocolContext = { registry };
        for (const protocol of protocols) {
            protocol.register(router, context);
        }
    };

    // Collect HTTP handlers from protocols
    const httpHandlers = protocols.map((p) => p.httpHandler).filter((h) => h != null);

    // Create HTTP/2 server adapter
    const handler = connectNodeAdapter({
        routes,
        interceptors,
        shutdownSignal,
        fallback(req, res) {
            // Delegate to protocol HTTP handlers
            for (const httpHandler of httpHandlers) {
                if (httpHandler(req as Http2ServerRequest, res as Http2ServerResponse)) {
                    return;
                }
            }

            // Default fallback
            res.statusCode = 404;
            res.end("Not Found");
        },
    });

    return { handler: handler as (req: Http2ServerRequest, res: Http2ServerResponse) => void, registry };
}
