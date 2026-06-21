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

// Standalone catalog client — the catalog-typed call/stream surface usable
// OUTSIDE a Server (workers, schedulers, CLIs).
export type { CatalogClient, CreateCatalogClientOptions } from "./catalogClient.ts";
export { createCatalogClient } from "./catalogClient.ts";
// Service catalog — declarative cross-service call primitives
export { CatalogConfigError } from "./catalogErrors.ts";
// Handler context (ctx.call / ctx.stream) + handler implementation types
export type { BidiStreamHandle, CallOptions, CatalogCall, CatalogStream, ClientStreamHandle, ConnectumMethodImpl, ConnectumServiceImpl, Context, StreamReturn } from "./context.ts";
// Service registration
export type { ServiceDefinition, ServiceOptions } from "./defineService.ts";
export { defineLazyService, defineService } from "./defineService.ts";
export { matchServicesPattern, mergeEnabledServices, parseServicesEnv } from "./enabledServices.ts";
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
export { defaultPropagateHeaders } from "./propagateHeaders.ts";
export type { DnsResolverOptions, PerServiceEnvResolverOptions, RemoteResolver, ResolverContext } from "./remoteResolver.ts";
export { dnsResolver, mapResolver, perServiceEnvResolver, singleTransportResolver } from "./remoteResolver.ts";
// Main createServer factory
export { createServer } from "./Server.ts";
export type { ConnectumCallMap, ConnectumStreamMap, ServiceCatalog } from "./serviceCatalog.ts";
export { defineCatalog, mergeCatalogs } from "./serviceCatalog.ts";

// =============================================================================
// UTILITIES
// =============================================================================

// Error protocol
export type { SanitizableError } from "./errors.ts";
export { isSanitizableError } from "./errors.ts";
// TLS utilities
export { getTLSPath, readTLSCertificates, tlsPath } from "./TLSConfig.ts";
// Transport validation (streaming kinds vs transport)
// EffectiveTransport / TransportValidationMode are const-object enums (ADR-001):
// they carry a runtime value AND a type, so they must be re-exported as values
// (a type-only re-export erases the const → undefined at runtime).
export type { StreamingMethodInfo } from "./TransportValidation.ts";
export {
    collectStreamingMethods,
    EffectiveTransport,
    resolveEffectiveTransport,
    TRANSPORT_VALIDATION_ERROR_CODE,
    TransportValidationError,
    TransportValidationMode,
} from "./TransportValidation.ts";

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
