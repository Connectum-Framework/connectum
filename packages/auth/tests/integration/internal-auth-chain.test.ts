/**
 * Integration tests for the INTERNAL AUTH -> PROTO AUTHZ interceptor chain (ADR-029).
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
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest } from "../helpers/proto-test-helpers.ts";

const PRINCIPAL = "cluster.local/ns/default/sa/trips";
const PRINCIPAL_HEADER = "x-forwarded-client-principal";

describe("Internal Auth Chain (INTERNAL AUTH -> PROTO AUTHZ) — Integration (ADR-029)", () => {
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
