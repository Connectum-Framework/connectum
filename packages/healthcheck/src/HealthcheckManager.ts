/**
 * Healthcheck state manager
 *
 * Manages health status for all registered services.
 * Module-level singleton accessed via `healthcheckManager` export.
 *
 * @module @connectum/healthcheck/HealthcheckManager
 */

import { type ServiceStatus, ServingStatus } from "./types.ts";

/**
 * Healthcheck manager
 *
 * Manages health status for all registered services.
 * Module-level singleton. Import `healthcheckManager` from the package.
 *
 * @example
 * ```typescript
 * import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * // After server.start():
 * healthcheckManager.update(ServingStatus.SERVING);
 * ```
 */
export class HealthcheckManager {
    private services: Map<string, ServiceStatus> = new Map();

    /**
     * Update service health status
     *
     * When called without a service name, updates ALL registered services.
     * When called with an unknown service name, throws an error.
     *
     * @param status - New serving status
     * @param service - Service name (if not provided, updates all services)
     * @throws Error if service name is provided but not registered
     */
    update(status: ServingStatus, service?: string): void {
        // No service specified: update ALL registered services
        if (service === undefined) {
            for (const key of this.services.keys()) {
                this.services.set(key, { status });
            }
            return;
        }

        // Specific service: validate it exists
        if (!this.services.has(service)) {
            throw new Error(`Unknown service '${service}'. Registered services: ${[...this.services.keys()].join(", ")}`);
        }

        this.services.set(service, { status });
    }

    /**
     * Get service health status
     *
     * @param service - Service name
     * @returns Service status or undefined if not found
     */
    getStatus(service: string): ServiceStatus | undefined {
        return this.services.get(service);
    }

    /**
     * Get all services health status
     *
     * @returns Map of service name to health status
     */
    getAllStatuses(): Map<string, ServiceStatus> {
        return new Map(this.services);
    }

    /**
     * Check if all services are healthy (SERVING)
     *
     * @returns True if all services are SERVING
     */
    areAllHealthy(): boolean {
        if (this.services.size === 0) {
            return false;
        }
        return Array.from(this.services.values()).every((s) => s.status === ServingStatus.SERVING);
    }

    /**
     * Initialize services map
     *
     * Merges new service names with existing state. Services that were
     * already registered retain their current status. New services start
     * with UNKNOWN status.
     *
     * @param serviceNames - Array of service names to track
     */
    initialize(serviceNames: string[]): void {
        const merged = new Map<string, ServiceStatus>();
        for (const name of serviceNames) {
            const existing = this.services.get(name);
            merged.set(name, existing ?? { status: ServingStatus.UNKNOWN });
        }
        this.services = merged;
    }

    /**
     * Clear all services
     */
    clear(): void {
        this.services.clear();
    }
}

/**
 * Create a new isolated HealthcheckManager instance
 *
 * Useful for testing or running multiple servers in one process.
 */
export function createHealthcheckManager(): HealthcheckManager {
    return new HealthcheckManager();
}
