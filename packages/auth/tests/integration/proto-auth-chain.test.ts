/**
 * Integration tests for JWT AUTH -> PROTO AUTHZ interceptor chain.
 *
 * Tests the full chain: JWT authentication followed by proto-based
 * authorization using custom options defined in protobuf descriptors.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { buildChainedHandler } from "../helpers/mock-request.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createProtoMockRequest, createServiceOptions } from "../helpers/proto-test-helpers.ts";

describe("Proto Auth Chain (JWT AUTH -> PROTO AUTHZ) — Integration", () => {
    const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
    const service = createFakeService({ serviceOptions: svcOpts });

    const publicMethod = createFakeMethod(service, "Health", createMethodOptions({ public: true }));
    const adminMethod = createFakeMethod(service, "AdminAction", createMethodOptions({ requires: { roles: ["admin"] } }));
    const scopedMethod = createFakeMethod(service, "ScopedAction", createMethodOptions({ requires: { roles: ["user"], scopes: ["items:write"] } }));
    const noOptionsMethod = createFakeMethod(service, "PlainMethod");

    function createChain() {
        const authInterceptor = createJwtAuthInterceptor({
            secret: TEST_JWT_SECRET,
            claimsMapping: { roles: "roles", scopes: "scope" },
            skipMethods: ["test.v1.TestService/Health"],
        });
        const authzInterceptor = createProtoAuthzInterceptor({ defaultPolicy: "deny" });
        return { authInterceptor, authzInterceptor };
    }

    describe("public methods", () => {
        it("should skip both authn and authz for public proto methods", async () => {
            const { authInterceptor, authzInterceptor } = createChain();
            const req = createProtoMockRequest(service, publicMethod);
            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            // No auth header, should pass because method is public
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("authorized access", () => {
        it("should allow admin user to access admin-protected method", async () => {
            const token = await createTestJwt({ sub: "admin-1", roles: ["admin"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, adminMethod, headers);

            let capturedContext: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            });

            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.ok(capturedContext!);
            assert.strictEqual(capturedContext!.subject, "admin-1");
            assert.deepStrictEqual([...capturedContext!.roles], ["admin"]);
        });

        it("should allow user with correct role and scopes", async () => {
            const token = await createTestJwt({ sub: "user-1", roles: ["user"], scope: "items:read items:write" });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, scopedMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should hand the handler the roles and the parsed scopes of the caller", async () => {
            const token = await createTestJwt({ sub: "user-3", roles: ["user"], scope: "items:read items:write" });
            const { authInterceptor, authzInterceptor } = createChain();
            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);

            let captured: ReturnType<typeof getAuthContext>;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });
            await buildChainedHandler(authInterceptor, authzInterceptor, next)(createProtoMockRequest(service, scopedMethod, headers));

            assert.deepStrictEqual([...captured!.roles], ["user"]);
            assert.deepStrictEqual([...captured!.scopes], ["items:read", "items:write"]);
        });
    });

    // Guide: scopes use all-of semantics. A method that requires two scopes shows it:
    // holding both (and more) passes, holding only one of them is refused. With a single
    // required scope the all-of and any-of readings cannot be told apart.
    describe("all-of scopes", () => {
        const twoScopeMethod = createFakeMethod(service, "TwoScopes", createMethodOptions({ requires: { scopes: ["items:read", "items:write"] } }));

        async function callWithScopes(scope: string) {
            const token = await createTestJwt({ sub: "scoped-user", roles: [], scope });
            const { authInterceptor, authzInterceptor } = createChain();
            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);
            return { run: () => handler(createProtoMockRequest(service, twoScopeMethod, headers)), next };
        }

        it("should allow a caller holding every required scope plus an extra one", async () => {
            const { run, next } = await callWithScopes("items:read items:write admin:extra");
            await run();
            assert.strictEqual(next.mock.calls.length, 1);
        });

        for (const scope of ["items:read", "items:write", "admin:extra items:other"]) {
            it(`should deny a caller holding only "${scope}"`, async () => {
                const { run, next } = await callWithScopes(scope);
                await assert.rejects(run(), (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                });
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }
    });

    describe("permission denied", () => {
        it("should deny user without required role on admin method", async () => {
            const token = await createTestJwt({ sub: "viewer-1", roles: ["viewer"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, adminMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should deny user with role but missing required scope", async () => {
            const token = await createTestJwt({ sub: "user-2", roles: ["user"], scope: "items:read" });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, scopedMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
        });
    });

    describe("default policy fallback", () => {
        it("should deny method without proto options when defaultPolicy is deny", async () => {
            const token = await createTestJwt({ sub: "admin-2", roles: ["admin"] });
            const { authInterceptor, authzInterceptor } = createChain();

            const headers = new Headers();
            headers.set("authorization", `Bearer ${token}`);
            const req = createProtoMockRequest(service, noOptionsMethod, headers);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as any).code, Code.PermissionDenied);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        // The two sources of the default are told apart one at a time: the service's own
        // default_policy and the interceptor's defaultPolicy. Each case changes one of them,
        // so a chain that ignored either source would give a different answer in one case.
        describe("one source of the default at a time", () => {
            const bareService = createFakeService({ typeName: "test.v1.BareService" });
            const bareMethod = createFakeMethod(bareService, "Plain");
            const denyingService = createFakeService({ typeName: "test.v1.DenyingService", serviceOptions: createServiceOptions({ defaultPolicy: "deny" }) });
            const denyingMethod = createFakeMethod(denyingService, "Plain");

            async function run(svc: typeof service, method: typeof bareMethod, interceptorPolicy: "allow" | "deny") {
                const token = await createTestJwt({ sub: "admin-3", roles: ["admin"] });
                const authInterceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, claimsMapping: { roles: "roles" } });
                const authzInterceptor = createProtoAuthzInterceptor({ defaultPolicy: interceptorPolicy });
                const headers = new Headers();
                headers.set("authorization", `Bearer ${token}`);
                const next = mock.fn(async () => ({ message: {} }));
                const outcome = await buildChainedHandler(authInterceptor, authzInterceptor, next)(createProtoMockRequest(svc, method, headers)).then(
                    () => "allowed",
                    (err: unknown) => (err as { code?: number }).code,
                );
                return { outcome, calls: next.mock.calls.length };
            }

            it("denies when only the interceptor says deny (no service policy)", async () => {
                assert.deepStrictEqual(await run(bareService, bareMethod, "deny"), { outcome: Code.PermissionDenied, calls: 0 });
            });

            it("allows when neither source says deny (interceptor allow, no service policy)", async () => {
                assert.deepStrictEqual(await run(bareService, bareMethod, "allow"), { outcome: "allowed", calls: 1 });
            });

            it("denies when only the service says deny (interceptor allow)", async () => {
                assert.deepStrictEqual(await run(denyingService, denyingMethod, "allow"), { outcome: Code.PermissionDenied, calls: 0 });
            });
        });
    });

    describe("unauthenticated access", () => {
        it("should reject non-public method without auth token", async () => {
            const { authInterceptor, authzInterceptor } = createChain();
            const req = createProtoMockRequest(service, adminMethod);

            const next = mock.fn(async () => ({ message: {} }));
            const handler = buildChainedHandler(authInterceptor, authzInterceptor, next);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });
    });
});
