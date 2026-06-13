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
 * @mergeModuleWith <project>
 */

// =============================================================================
// SERVER API
// =============================================================================

// In-process transport
//
// NOTE: `LOCAL_TRANSPORT_HEADER` and `LOCAL_TRANSPORT_VALUE` are intentionally
// NOT re-exported from the public surface (security finding F3, P2.a). They
// are framework-internal markers used by `createLocalTransport` and
// `@connectum/otel` (which duplicates the literal values locally). Exposing
// them publicly would encourage external callers to forge or rely on the
// header — see SECURITY_REVIEW.md §4 F1.
export type { CreateLocalTransportOptions } from "./localTransport.ts";
export { createLocalTransport } from "./localTransport.ts";
// Main createServer factory
export { createServer } from "./Server.ts";

// =============================================================================
// UTILITIES
// =============================================================================

// Error protocol
export type { SanitizableError } from "./errors.ts";
export { isSanitizableError } from "./errors.ts";
// TLS utilities
export { getTLSPath, readTLSCertificates, tlsPath } from "./TLSConfig.ts";
// Transport validation (streaming kinds vs transport)
export type { EffectiveTransport, StreamingMethodInfo, TransportValidationMode } from "./TransportValidation.ts";
export { collectStreamingMethods, resolveEffectiveTransport, TRANSPORT_VALIDATION_ERROR_CODE, TransportValidationError } from "./TransportValidation.ts";

// =============================================================================
// TYPES
// =============================================================================

export type {
    CreateServerOptions,
    // Event bus integration
    EventBusLike,
    HttpHandler,
    // Transport union types
    NodeRequest,
    NodeResponse,
    ProtocolContext,
    // Protocol Registration API
    ProtocolRegistration,
    // Server API
    Server,
    ServerClientOptions,
    // Common types
    ServiceRoute,
    ShutdownHook,
    ShutdownOptions,
    TLSOptions,
    TransportServer,
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
