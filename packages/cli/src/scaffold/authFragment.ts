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

/** Path of the base sample's proto, annotated by {@link applyAuthProtoAnnotations}. */
export const GREETER_PROTO_PATH = "proto/greeter/v1/greeter.proto";

/**
 * Annotate the base Greeter proto for the auth module.
 *
 * `createProtoAuthzInterceptor()` is **deny-by-default**, so an unannotated proto makes
 * every rpc unreachable — a scaffolded `--auth` project would reject its own sample call
 * with `[unauthenticated] Missing credentials`. This adds the annotation that makes the
 * starter honest *and* demonstrative:
 *
 * - `SayHello` -> `{ public: true }`: skips authn/authz, reachable out of the box;
 * - `SayGoodbye` -> left unannotated: requires a valid JWT, so the generated e2e test can
 *   assert that the auth chain actually rejects an unauthenticated call.
 *
 * @param source - The fetched `greeter.proto` contents
 * @returns The annotated proto
 * @throws Error if the expected `SayHello` rpc is absent — failing loudly beats emitting
 *   a project whose sample call cannot succeed.
 */
export function applyAuthProtoAnnotations(source: string): string {
    const sayHello = /(\s*)rpc SayHello\(SayHelloRequest\) returns \(SayHelloResponse\) \{\}/;
    if (!sayHello.test(source)) {
        throw new Error(
            `connectum init: could not annotate ${GREETER_PROTO_PATH} for the auth module — the expected \`rpc SayHello\` declaration was not found in the fetched base. Re-run without --auth, or open an issue: the base example and the CLI have drifted.`,
        );
    }
    const annotated = source.replace(
        sayHello,
        (_match, indent: string) =>
            `${indent}// Public: skips authentication and authorization, so the sample call works` +
            `${indent}// out of the box. Remove this option to require a JWT (as SayGoodbye does).` +
            `${indent}rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {` +
            `${indent}  option (connectum.auth.v1.method_auth) = { public: true };` +
            `${indent}}`,
    );
    return annotated.replace(/^(package\s+[^;]+;\n)/m, `$1\nimport "connectum/auth/v1/options.proto";\n`);
}

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
