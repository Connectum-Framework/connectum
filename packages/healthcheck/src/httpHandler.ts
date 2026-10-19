/**
 * HTTP Health Check Handler
 *
 * Provides HTTP endpoints for health checking that mirror the gRPC healthcheck status.
 * Disabled by default, enabled via HealthcheckOptions.httpEnabled.
 */

import type { HttpHandler, NodeRequest, NodeResponse } from "@connectum/core";
import type { HealthcheckManager } from "./HealthcheckManager.ts";
import { ServingStatus } from "./types.ts";

/**
 * HTTP status codes mapped from gRPC ServingStatus
 */
const STATUS_TO_HTTP = new Map<ServingStatus, number>([
    [ServingStatus.SERVING, 200],
    [ServingStatus.NOT_SERVING, 503],
    [ServingStatus.SERVICE_UNKNOWN, 404],
    [ServingStatus.UNKNOWN, 503],
]);

/**
 * Human-readable status names mapped from ServingStatus values
 *
 * Uses explicit Map instead of enum reverse mapping for safety.
 */
const STATUS_NAMES = new Map<ServingStatus, string>([
    [ServingStatus.UNKNOWN, "UNKNOWN"],
    [ServingStatus.SERVING, "SERVING"],
    [ServingStatus.NOT_SERVING, "NOT_SERVING"],
    [ServingStatus.SERVICE_UNKNOWN, "SERVICE_UNKNOWN"],
]);

/**
 * HTTP health response body
 */
interface HttpHealthResponse {
    status: string;
    service: string;
    timestamp: string;
}

/**
 * Default HTTP health paths
 */
const DEFAULT_HTTP_PATHS = ["/healthz", "/health", "/readyz"];

/**
 * Create an HTTP handler that reports the health manager's current status.
 *
 * Configured paths return JSON with the service name, status, and timestamp.
 * A `service` query parameter checks one service or component; without it,
 * the handler reports overall health (an empty `service=` counts as absent).
 * Unknown named services return 404 with the requested name in the body,
 * unhealthy overall status returns 503, and unconfigured paths are not handled.
 *
 * Matching rules: the request path is compared with the configured paths by
 * exact, case-sensitive equality without normalization (`/healthz/` does not
 * match `/healthz`); the query string is ignored when matching; the request
 * method is not checked; the `Host` header is not consulted.
 *
 * @param manager - Healthcheck manager instance
 * @param healthPaths - HTTP health endpoint paths
 * @returns HTTP handler function that returns true if request was handled
 */
export function createHttpHealthHandler(manager: HealthcheckManager, healthPaths: string[] = DEFAULT_HTTP_PATHS): HttpHandler {
    const pathSet = new Set(healthPaths);

    return function httpHealthHandler(req: NodeRequest, res: NodeResponse): boolean {
        const url = req.url ?? "";
        const pathname = url.split("?")[0] ?? "";

        // Only handle configured health paths
        if (!pathSet.has(pathname)) {
            return false;
        }

        const service = parseServiceFromUrl(url);

        // Get status from the same manager used by gRPC healthcheck
        const serviceStatus = service ? manager.getStatus(service) : undefined;

        // Determine effective status
        let status: ServingStatus;
        if (service && !serviceStatus) {
            status = ServingStatus.SERVICE_UNKNOWN;
        } else if (serviceStatus) {
            status = serviceStatus.status;
        } else {
            // Overall healthcheck if all services are healthy
            status = manager.areAllHealthy() ? ServingStatus.SERVING : ServingStatus.NOT_SERVING;
        }

        const httpStatus = STATUS_TO_HTTP.get(status) ?? 503;

        const body: HttpHealthResponse = {
            status: STATUS_NAMES.get(status) ?? "UNKNOWN",
            service: service ?? "overall",
            timestamp: new Date().toISOString(),
        };

        res.statusCode = httpStatus;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));

        return true;
    };
}

/**
 * Base used to resolve a relative request target. Only the query string is
 * read, so any valid origin works; a constant keeps the result independent of
 * the client-controlled `Host` header, which can be empty or malformed over
 * HTTP/1.1.
 */
const URL_BASE = "http://localhost";

/**
 * Read the optional `service` query parameter from a request URL.
 *
 * Returns `undefined` when the URL is absent, malformed, or has no `service`
 * parameter. An empty value (`?service=`) is returned as the empty string.
 * The result depends on the URL alone: the `Host` header never changes it.
 *
 * @param url - Request target, usually `req.url`
 * @param _host - Accepted for backward compatibility only; it has no effect
 *   on the result and is removed in the next major version
 *
 * @example
 * ```typescript
 * parseServiceFromUrl('/healthz?service=my.service.v1.MyService')
 * // returns 'my.service.v1.MyService'
 * ```
 */
export function parseServiceFromUrl(url: string | undefined, _host?: string): string | undefined {
    if (!url) return undefined;

    try {
        const parsed = new URL(url, URL_BASE);
        return parsed.searchParams.get("service") ?? undefined;
    } catch {
        return undefined;
    }
}
