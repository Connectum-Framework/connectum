/**
 * Healthcheck state manager
 *
 * Manages health status for all registered services and components.
 * Module-level singleton accessed via `healthcheckManager` export.
 *
 * @module @connectum/healthcheck/HealthcheckManager
 */

import { type ServiceStatus, ServingStatus } from "./types.ts";

/**
 * Registry entry kind.
 *
 * - `service` — a Connect RPC service, owned by the Healthcheck protocol:
 *   `initialize()` adds, preserves, and removes these.
 * - `component` — an application-defined health component (process, broker
 *   connection, ...), owned by the application: `initialize()` never touches
 *   these.
 */
const EntryKind = {
    SERVICE: "service",
    COMPONENT: "component",
} as const;

type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

/**
 * Internal registry entry. The `kind` tag is deliberately NOT exposed through
 * `getStatus()`/`getAllStatuses()`: their `ServiceStatus` shape feeds directly
 * into the gRPC `HealthListResponse`, and an extra field must not leak into
 * the wire contract.
 */
interface HealthEntry {
    status: ServingStatus;
    kind: EntryKind;
}

/**
 * Validate a component name: non-empty and dot-free.
 *
 * Conventionally packaged proto services have dotted typeNames
 * (`package.Service`), so dot-free component names do not collide with them.
 * A package-less service (dot-free typeName) is the rare exception; the kind
 * check in `register`/`set`/`unregister` and `initialize` covers it
 * defensively. The dot syntax is reserved for service typeNames.
 */
function assertValidComponentName(component: string): void {
    if (component === "") {
        throw new Error("Component name must not be empty");
    }
    if (component.includes(".")) {
        throw new Error(`Component name '${component}' must not contain dots: dotted names are reserved for RPC service typeNames`);
    }
}

/**
 * Healthcheck manager
 *
 * Manages health status for all registered services and components.
 * Module-level singleton. Import `healthcheckManager` from the package.
 *
 * @example RPC service status (after server.start())
 * ```typescript
 * import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * healthcheckManager.update(ServingStatus.SERVING);
 * ```
 *
 * @example RPC-less worker (poller, publisher, exporter)
 * ```typescript
 * import { healthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * healthcheckManager.register('process');           // before or after start
 * server.on('ready', () => healthcheckManager.set('process', ServingStatus.SERVING));
 * server.on('stopping', () => healthcheckManager.set('process', ServingStatus.NOT_SERVING));
 * ```
 */
export class HealthcheckManager {
    private entries: Map<string, HealthEntry> = new Map();

    /**
     * Update service health status
     *
     * When called without a service name, updates ALL registered entries
     * (services and components alike).
     * When called with an unknown service name, throws an error.
     *
     * @param status - New serving status
     * @param service - Service name (if not provided, updates all entries)
     * @throws Error if service name is provided but not registered
     */
    update(status: ServingStatus, service?: string): void {
        // No service specified: update ALL registered entries
        if (service === undefined) {
            for (const [key, entry] of this.entries) {
                this.entries.set(key, { status, kind: entry.kind });
            }
            return;
        }

        // Specific service: validate it exists
        const existing = this.entries.get(service);
        if (existing === undefined) {
            throw new Error(`Unknown service '${service}'. Registered services: ${[...this.entries.keys()].join(", ")}`);
        }

        this.entries.set(service, { status, kind: existing.kind });
    }

    /**
     * Register an application health component.
     *
     * A registered component is a readiness gate: it participates in
     * `areAllHealthy()`, gRPC `Check`/`Watch`, and `/healthz` exactly like an
     * RPC service. Registering an already-registered component does NOT reset
     * its status. Component names must be non-empty and dot-free.
     *
     * @param component - Component name (e.g. "process", "amqp")
     * @param initialStatus - Initial status (default UNKNOWN)
     * @throws Error on invalid name or when the name belongs to an RPC service
     */
    register(component: string, initialStatus: ServingStatus = ServingStatus.UNKNOWN): void {
        assertValidComponentName(component);

        const existing = this.entries.get(component);
        if (existing !== undefined) {
            if (existing.kind === EntryKind.SERVICE) {
                throw new Error(`Name '${component}' is a registered RPC service, not a component`);
            }
            // Re-register: keep current status
            return;
        }

        this.entries.set(component, { status: initialStatus, kind: EntryKind.COMPONENT });
    }

    /**
     * Set a component's status (upsert).
     *
     * Unlike `update()`, does not throw for unknown names: the component is
     * registered first if absent. Component names must be non-empty and
     * dot-free.
     *
     * @param component - Component name
     * @param status - New serving status
     * @throws Error on invalid name or when the name belongs to an RPC service
     */
    set(component: string, status: ServingStatus): void {
        assertValidComponentName(component);

        const existing = this.entries.get(component);
        if (existing !== undefined && existing.kind === EntryKind.SERVICE) {
            throw new Error(`Name '${component}' is a registered RPC service, not a component`);
        }

        this.entries.set(component, { status, kind: EntryKind.COMPONENT });
    }

    /**
     * Remove a registered component.
     *
     * @param component - Component name
     * @throws Error when the name belongs to an RPC service
     */
    unregister(component: string): void {
        const existing = this.entries.get(component);
        if (existing === undefined) {
            return;
        }
        if (existing.kind === EntryKind.SERVICE) {
            throw new Error(`Name '${component}' is a registered RPC service, not a component`);
        }
        this.entries.delete(component);
    }

    /**
     * Get service health status
     *
     * @param service - Service or component name
     * @returns Service status or undefined if not found
     */
    getStatus(service: string): ServiceStatus | undefined {
        const entry = this.entries.get(service);
        return entry === undefined ? undefined : { status: entry.status };
    }

    /**
     * Get all services health status
     *
     * @returns Map of service/component name to health status
     */
    getAllStatuses(): Map<string, ServiceStatus> {
        const result = new Map<string, ServiceStatus>();
        for (const [key, entry] of this.entries) {
            result.set(key, { status: entry.status });
        }
        return result;
    }

    /**
     * Check if all services and components are healthy (SERVING)
     *
     * @returns True if all entries are SERVING; false for an empty registry
     */
    areAllHealthy(): boolean {
        if (this.entries.size === 0) {
            return false;
        }
        return Array.from(this.entries.values()).every((e) => e.status === ServingStatus.SERVING);
    }

    /**
     * Initialize the RPC service slice of the registry.
     *
     * Affects only `service`-kind entries:
     * - names in `serviceNames` are added (UNKNOWN) or preserved with their
     *   current status;
     * - `service` entries absent from `serviceNames` are removed — pollers on
     *   `watch` observe SERVICE_UNKNOWN for them afterwards;
     * - `component` entries are never touched, so components registered
     *   before `server.start()` survive protocol initialization.
     *
     * Called by the Healthcheck protocol on server start; not intended for
     * application code.
     *
     * @param serviceNames - Array of RPC service typeNames to track
     */
    initialize(serviceNames: string[]): void {
        const incoming = new Set(serviceNames);

        // Remove stale services (never components): a service absent from the
        // registry must not stay SERVING forever — that would be fail-open.
        for (const [key, entry] of this.entries) {
            if (entry.kind === EntryKind.SERVICE && !incoming.has(key)) {
                this.entries.delete(key);
            }
        }

        for (const name of serviceNames) {
            const existing = this.entries.get(name);
            if (existing === undefined) {
                this.entries.set(name, { status: ServingStatus.UNKNOWN, kind: EntryKind.SERVICE });
            }
            // Existing service: keep status. Existing component with the same
            // name: unreachable in practice (typeNames are dotted, component
            // names are dot-free) — left untouched rather than failing start.
        }
    }

    /**
     * Clear all services and components
     */
    clear(): void {
        this.entries.clear();
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
