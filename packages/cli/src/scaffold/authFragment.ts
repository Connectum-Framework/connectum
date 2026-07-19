/**
 * The `auth` module fragment for `connectum init` (task 2.4). Adds `@connectum/auth`
 * (JWT authentication + proto-driven authorization). The auth option proto is resolved
 * from `node_modules/@connectum/auth/proto` as a **second buf module** (not vendored),
 * so `install` must run before `buf generate` — which the lifecycle-fix guarantees
 * (buf generate runs on test/start, after install).
 *
 * APIs verified against `@connectum/auth` / `@connectum/auth/proto`.
 *
 * @module scaffold/authFragment
 */

/** The buf module path for the (installed) auth option proto. */
export const AUTH_BUF_MODULE = "node_modules/@connectum/auth/proto";

/** `src/auth.ts` — builds the JWT + proto-authz interceptor chain. */
export function generateAuthFile(): string {
    return `/**
 * Authentication (JWT via JWKS) + authorization (driven by proto \`(connectum.auth.v1.*)\`
 * annotations). Configure via env: JWKS_URI, JWT_ISSUER, JWT_AUDIENCE.
 *
 * @module auth
 */

import { createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getPublicMethods } from "@connectum/auth/proto";
import type { Interceptor } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter/v1/greeter_pb.ts";

// Methods annotated \`(connectum.auth.v1.method_auth) = { public: true }\` in your proto
// are read here and skipped by the JWT interceptor. Add your services to this list.
const publicMethods = getPublicMethods([GreeterService]);

/**
 * Build the auth interceptor chain: JWT authentication followed by proto-driven
 * authorization (deny-by-default — annotate methods/services to allow).
 */
export function buildAuthInterceptors(): Interceptor[] {
    const jwtAuth = createJwtAuthInterceptor({
        jwksUri: process.env.JWKS_URI ?? "http://localhost:8080/.well-known/jwks.json",
        issuer: process.env.JWT_ISSUER,
        audience: process.env.JWT_AUDIENCE,
        algorithms: ["RS256"],
        skipMethods: [...publicMethods, "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
    });
    const authz = createProtoAuthzInterceptor();
    return [jwtAuth, authz];
}
`;
}
