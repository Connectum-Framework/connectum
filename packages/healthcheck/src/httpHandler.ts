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
 * the handler reports overall health. Unknown named services return 404,
 * unhealthy overall status returns 503, and unconfigured paths are not handled.
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

        const service = parseServiceFromUrl(url, req.headers.host as string | undefined);

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
 * Read the optional `service` query parameter from a request URL.
 *
 * Returns `undefined` when the URL is absent, malformed, or has no `service`
 * parameter. The host is used only to resolve relative URLs.
 *
 * @example
 * ```typescript
 * parseServiceFromUrl('/healthz?service=my.service.v1.MyService', req.headers.host)
 * // returns 'my.service.v1.MyService'
 * ```
 */
export function parseServiceFromUrl(url: string | undefined, host: string | undefined): string | undefined {
    if (!url) return undefined;

    try {
        const parsed = new URL(url, `http://${host ?? "localhost"}`);
        return parsed.searchParams.get("service") ?? undefined;
    } catch {
        return undefined;
    }
}
