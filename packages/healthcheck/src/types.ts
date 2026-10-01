/**
 * Healthcheck protocol types
 *
 * @module @connectum/healthcheck/types
 */

import { HealthCheckResponse_ServingStatus } from "#gen/grpc/health/v1/health_pb.js";

/**
 * Service serving status
 *
 * The `HealthCheckResponse.ServingStatus` enum of the standard gRPC Health
 * Checking Protocol (`grpc.health.v1`), re-exported from the generated code.
 * Values: `UNKNOWN` (0), `SERVING` (1), `NOT_SERVING` (2) and
 * `SERVICE_UNKNOWN` (3), which the protocol uses only in `Watch` responses.
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
