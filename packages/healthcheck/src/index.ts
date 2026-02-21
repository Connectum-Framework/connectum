/**
 * @module @connectum/healthcheck
 */

// Factory + Singleton manager
export { Healthcheck, healthcheckManager } from "./Healthcheck.ts";
// Manager class + factory
/**
 * Create a new isolated HealthcheckManager instance
 *
 * Useful for testing or running multiple servers in one process,
 * avoiding shared state via the default singleton.
 *
 * @example
 * ```typescript
 * import { Healthcheck, createHealthcheckManager, ServingStatus } from '@connectum/healthcheck';
 *
 * const manager = createHealthcheckManager();
 * const server = createServer({
 *   protocols: [Healthcheck({ manager })],
 * });
 * manager.update(ServingStatus.SERVING);
 * ```
 */
export { createHealthcheckManager, HealthcheckManager } from "./HealthcheckManager.ts";

// HTTP handler
export { createHttpHealthHandler, parseServiceFromUrl } from "./httpHandler.ts";

// Types
export { type HealthcheckOptions, type ServiceStatus, ServingStatus } from "./types.ts";
