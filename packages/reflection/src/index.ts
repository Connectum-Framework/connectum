/**
 * @connectum/reflection
 *
 * gRPC Server Reflection protocol for Connectum framework.
 *
 * Provides:
 * - Reflection: Factory to create reflection protocol registration
 * - collectFileProtos: Utility to collect file descriptors with dependencies
 *
 * @module @connectum/reflection
 */

// Factory
export { Reflection } from "./Reflection.ts";

// Utilities
export { collectFileProtos } from "./utils.ts";
