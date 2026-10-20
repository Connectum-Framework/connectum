/**
 * Integration tests for the INTERNAL AUTH -> PROTO AUTHZ interceptor chain.
 *
 * Exercises the LOAD-BEARING seam: createInternalAuthInterceptor must run
 * BEFORE createProtoAuthzInterceptor and populate the AuthContext that
 * proto-authz's `internal` rule consumes (`errorHandler -> internalAuth ->
 * protoAuthz`). The unit tests cover each half in isolation; these tests prove
 * the two compose correctly end-to-end with the real interceptors chained.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createInternalAuthInterceptor, meshIdentityTrust } from "../../src/internal-auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { getInternalMethods, getPublicMethods } from "../../src/proto/reader.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import type { AuthContext } from "../../src/types.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest, createServiceOptions } from "../helpers/proto-test-helpers.ts";

const PRINCIPAL = "cluster.local/ns/default/sa/trips";
const PRINCIPAL_HEADER = "x-forwarded-client-principal";

describe("Internal Auth Chain (INTERNAL AUTH -> PROTO AUTHZ) — Integration", () => {
    // service has default_policy deny so an internal method MUST be allowed by
    // the internal rule, not by any default-allow shortcut.
    const service = createFakeService({ typeName: "trips.v1.TripService" });
    const internalMethod = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true }), { register: true });
    const internalGatedMethod = createFakeMethod(service, "EndTrip", createMethodOptions({ internal: true, requires: { roles: ["worker"] } }), { register: true });

    function chain(allowlist: Parameters<typeof meshIdentityTrust>[0]["allowlist"]) {
        const internalAuth = createInternalAuthInterceptor({
            internalMethods: ["trips.v1.TripService/RecordTrip", "trips.v1.TripService/EndTrip"],
            trustSource: meshIdentityTrust({ allowlist }),
        });
        const protoAuthz = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
        return { internalAuth, protoAuthz };
    }

    it("positive: allow-listed principal flows identity through the chain to the handler", async () => {
        const { internalAuth, protoAuthz } = chain([{ principal: PRINCIPAL, roles: ["worker"], scopes: ["trip:write"] }]);

        let seenInHandler: AuthContext | undefined;
        const next = mock.fn(async () => {
            seenInHandler = getAuthContext();
            return { message: {} };
        });
        const handler = buildChainedHandler(internalAuth, protoAuthz, next);

        const req = createProtoMockRequest(service, internalMethod, new Headers({ [PRINCIPAL_HEADER]: PRINCIPAL }));
        await handler(req);

        assert.strictEqual(next.mock.calls.length, 1, "handler reached through the real chain");
        // Identity set by the internal interceptor is visible in the handler
        // (proves internalAuth ran before protoAuthz and the store propagated).
        assert.strictEqual(seenInHandler?.subject, PRINCIPAL);
        assert.deepStrictEqual([...(seenInHandler?.roles ?? [])], ["worker"]);
        assert.strictEqual(seenInHandler?.type, "mesh");
    });

    it("negative: no principal header -> Unauthenticated, handler not reached", async () => {
        const { internalAuth, protoAuthz } = chain([{ principal: PRINCIPAL, roles: ["worker"] }]);
        const next = mock.fn(async () => ({ message: {} }));
        const handler = buildChainedHandler(internalAuth, protoAuthz, next);

        const req = createProtoMockRequest(service, internalMethod); // no headers
        await assert.rejects(
            () => handler(req),
            (err: unknown) => {
                assertConnectError(err, Code.Unauthenticated);
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 0);
    });

    it("inclusive roles (real chain): internal + requires{worker}, caller has worker -> allowed", async () => {
        const { internalAuth, protoAuthz } = chain([{ principal: PRINCIPAL, roles: ["worker"] }]);
        const next = mock.fn(async () => ({ message: {} }));
        const handler = buildChainedHandler(internalAuth, protoAuthz, next);

        const req = createProtoMockRequest(service, internalGatedMethod, new Headers({ [PRINCIPAL_HEADER]: PRINCIPAL }));
        await handler(req);

        assert.strictEqual(next.mock.calls.length, 1);
    });

    it("inclusive roles (real chain): internal + requires{worker}, caller lacks worker -> PermissionDenied", async () => {
        // Allow-listed (so identity is established) but WITHOUT the required role.
        const { internalAuth, protoAuthz } = chain([{ principal: PRINCIPAL, roles: ["viewer"] }]);
        const next = mock.fn(async () => ({ message: {} }));
        const handler = buildChainedHandler(internalAuth, protoAuthz, next);

        const req = createProtoMockRequest(service, internalGatedMethod, new Headers({ [PRINCIPAL_HEADER]: PRINCIPAL }));
        await assert.rejects(
            () => handler(req),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.strictEqual((err as Error).name, "AuthzDeniedError");
                assert.strictEqual((err as { code?: unknown }).code, Code.PermissionDenied);
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 0);
    });
});

// The guide's chain for a service with public, internal and gated methods: JWT authentication
// skips the public and the internal methods (both lists derived from the proto annotations),
// the internal interceptor authenticates the internal ones from the mesh principal, and proto
// authz decides last. Each method must open only through its own kind of credential.
describe("JWT + internal auth + proto authz chain with lists derived from the proto annotations", () => {
    const service = createFakeService({ typeName: "mixed.v1.MixedService", serviceOptions: createServiceOptions({ defaultPolicy: "deny" }) });
    const publicMethod = createFakeMethod(service, "Health", createMethodOptions({ public: true }), { register: true });
    const internalMethod = createFakeMethod(service, "RecordTrip", createMethodOptions({ internal: true }), { register: true });
    const gatedMethod = createFakeMethod(service, "AdminAction", createMethodOptions({ requires: { roles: ["admin"] } }), { register: true });

    /** Run one call through the three interceptors; report whether the handler ran or the error code. */
    async function call(method: typeof publicMethod, headers: Record<string, string>): Promise<{ outcome: "reached" | number | undefined; reached: number }> {
        const jwtAuth = createJwtAuthInterceptor({
            secret: TEST_JWT_SECRET,
            claimsMapping: { roles: "roles" },
            skipMethods: [...getPublicMethods([service]), ...getInternalMethods([service])],
        });
        const internalAuth = createInternalAuthInterceptor({
            internalMethods: getInternalMethods([service]),
            trustSource: meshIdentityTrust({ allowlist: [{ principal: PRINCIPAL, roles: ["worker"] }] }),
        });
        const protoAuthz = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
        const next = mock.fn(async () => ({ message: {} }));
        const handler = buildChainedHandler(jwtAuth, internalAuth, protoAuthz(next as never));
        const outcome = await handler(createProtoMockRequest(service, method, new Headers(headers))).then(
            () => "reached" as const,
            (err: unknown) => (err as { code?: number }).code,
        );
        return { outcome, reached: next.mock.calls.length };
    }

    it("opens a public method without any credential", async () => {
        assert.deepStrictEqual(await call(publicMethod, {}), { outcome: "reached", reached: 1 });
    });

    it("opens an internal method to an allow-listed mesh principal without a user token", async () => {
        assert.deepStrictEqual(await call(internalMethod, { [PRINCIPAL_HEADER]: PRINCIPAL }), { outcome: "reached", reached: 1 });
    });

    it("keeps an internal method closed to a caller with neither a principal nor a token", async () => {
        assert.deepStrictEqual(await call(internalMethod, {}), { outcome: Code.Unauthenticated, reached: 0 });
    });

    it("does not let a valid user token stand in for the mesh principal on an internal method", async () => {
        const token = await createTestJwt({ sub: "admin-1", roles: ["admin"] });

        assert.deepStrictEqual(await call(internalMethod, { authorization: `Bearer ${token}` }), { outcome: Code.Unauthenticated, reached: 0 });
    });

    it("opens a gated method to a user token with the required role", async () => {
        const token = await createTestJwt({ sub: "admin-1", roles: ["admin"] });

        assert.deepStrictEqual(await call(gatedMethod, { authorization: `Bearer ${token}` }), { outcome: "reached", reached: 1 });
    });

    it("does not let a mesh principal open a gated method that needs a user token", async () => {
        assert.deepStrictEqual(await call(gatedMethod, { [PRINCIPAL_HEADER]: PRINCIPAL }), { outcome: Code.Unauthenticated, reached: 0 });
    });
});
