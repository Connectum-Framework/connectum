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

export type {
    CreateServerOptions,
    HttpHandler,
    ProtocolContext,
    // Protocol Registration API
    ProtocolRegistration,
    // Server API
    Server,
    // Common types
    ServiceRoute,
    ShutdownHook,
    ShutdownOptions,
    TLSOptions,
} from "./types.ts";
// Server API types
export { LifecycleEvent, ServerState } from "./types.ts";

// =============================================================================
// CONFIGURATION
// =============================================================================

// Environment configuration (12-Factor App)
export {
    BooleanFromStringSchema,
    type ConnectumEnv,
    ConnectumEnvSchema,
    LogFormatSchema,
    LoggerBackendSchema,
    LogLevelSchema,
    NodeEnvSchema,
    parseEnvConfig,
    safeParseEnvConfig,
} from "./config/index.ts";
