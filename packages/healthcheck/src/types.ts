/**
 * Healthcheck protocol types
 *
 * @module @connectum/healthcheck/types
 */

import { HealthCheckResponse_ServingStatus } from "#gen/grpc/health/v1/health_pb.js";

/**
 * Service serving status
 *
 * Re-export generated const from proto.
 */
export const ServingStatus = HealthCheckResponse_ServingStatus;
export type ServingStatus = HealthCheckResponse_ServingStatus;

/**
 * Service health status
 */
export interface ServiceStatus {
    status: ServingStatus;
}

/**
 * Healthcheck protocol options
 */
export interface HealthcheckOptions {
    /**
     * Enable HTTP health endpoints
     * @default false
     */
    httpEnabled?: boolean;

    /**
     * HTTP health endpoint paths that all respond with health status.
     * @default ["/healthz", "/health", "/readyz"]
     */
    httpPaths?: string[];

    /**
     * Watch interval in milliseconds for streaming health updates
     * @default 500
     */
    watchInterval?: number;

    /**
     * Custom HealthcheckManager instance.
     * Useful for testing or running multiple servers in one process.
     * When not provided, uses the default module-level singleton.
     */
    manager?: import("./HealthcheckManager.ts").HealthcheckManager;
}
