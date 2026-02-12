/**
 * @connectum/core
 *
 * Main entry point for Connectum framework.
 *
 * Provides:
 * - createServer: Factory function to create ConnectRPC server with explicit lifecycle
 * - Server: Server interface with start/stop control
 * - ProtocolRegistration: Interface for protocol plugins (healthcheck, reflection, custom)
 * - TLS: Configuration utilities
 *
 * @module @connectum/core
 */

// =============================================================================
// SERVER API
// =============================================================================

// Main createServer factory
export { createServer } from "./Server.ts";

// =============================================================================
// UTILITIES
// =============================================================================

// TLS utilities
export { getTLSPath, readTLSCertificates, tlsPath } from "./TLSConfig.ts";

// =============================================================================
// TYPES
// =============================================================================

// Server API types
export { ServerState, LifecycleEvent } from "./types.ts";

export type {
    // Server API
    Server,
    CreateServerOptions,
    ShutdownOptions,
    ShutdownHook,
    // Protocol Registration API
    ProtocolRegistration,
    ProtocolContext,
    HttpHandler,
    // Common types
    ServiceRoute,
    TLSOptions,
} from "./types.ts";

// =============================================================================
// CONFIGURATION
// =============================================================================

// Environment configuration (12-Factor App)
export {
    ConnectumEnvSchema,
    LogLevelSchema,
    LogFormatSchema,
    LoggerBackendSchema,
    NodeEnvSchema,
    BooleanFromStringSchema,
    parseEnvConfig,
    safeParseEnvConfig,
    type ConnectumEnv,
} from "./config/index.ts";
