/**
 * Proto-based authorization configuration.
 *
 * Provides access to protobuf custom options for declarative authorization
 * defined in .proto files, plus utilities for reading and resolving
 * service/method-level authorization settings.
 *
 * @module proto
 */

export type { AuthRequirements, MethodAuth, ServiceAuth } from "#gen/connectum/auth/v1/options_pb.js";
// Re-export generated types and extension descriptors
export { AuthRequirementsSchema, MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";
// Re-export proto-based authorization interceptor
export { createProtoAuthzInterceptor } from "./proto-authz-interceptor.ts";
export type { ResolvedMethodAuth } from "./reader.ts";
// Re-export reader utilities
export { getPublicMethods, resolveMethodAuth } from "./reader.ts";
