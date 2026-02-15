/**
 * Unit tests for the authorization interceptor
 *
 * Tests createAuthzInterceptor() for rule evaluation, default policies,
 * role/scope checking, skip patterns, and programmatic authorization.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createAuthzInterceptor } from "../../src/authz-interceptor.ts";
import { authContextStorage } from "../../src/context.ts";
import type { AuthContext, AuthzRule } from "../../src/types.ts";
import { AuthzEffect } from "../../src/types.ts";

function createMockRequest(overrides: Record<string, unknown> = {}) {
    return {
        service: { typeName: "test.Service" },
        method: { name: "Method" },
        header: new Headers(),
        url: "http://localhost/test.Service/Method",
        stream: false,
        message: {},
        ...overrides,
    } as any;
}

function createMockNext() {
    return mock.fn(async (_req: any) => ({ message: {} })) as any;
}

const defaultContext: AuthContext = {
    subject: "user-1",
    roles: ["admin"],
    scopes: ["read"],
    claims: {},
    type: "test",
};

describe("authz-interceptor", () => {
    describe("createAuthzInterceptor()", () => {
        it("should deny by default when no rules match (defaultPolicy: deny)", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    assert.ok(err.message.includes("default policy"));
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should allow when defaultPolicy is allow", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.ALLOW,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should evaluate rules in order (first match wins)", async () => {
            const rules: AuthzRule[] = [
                { name: "deny-all", methods: ["*"], effect: AuthzEffect.DENY },
                { name: "allow-all", methods: ["*"], effect: AuthzEffect.ALLOW },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.ALLOW,
                rules,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await assert.rejects(
                () => authContextStorage.run(defaultContext, () => handler(req)),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual((err as ConnectError).code, Code.PermissionDenied);
                    assert.ok((err as Error).message.includes("deny-all"));
                    assert.strictEqual((err as Error).name, "AuthzDeniedError");
                    return true;
                },
            );
        });

        it("should check role requirements (any-of matching)", async () => {
            const rules: AuthzRule[] = [
                {
                    name: "admin-only",
                    methods: ["*"],
                    effect: AuthzEffect.ALLOW,
                    requires: { roles: ["admin", "superadmin"] },
                },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules,
            });
            const next = createMockNext();
            const handler = interceptor(next);
            const req = createMockRequest();

            // User has "admin" role -> should match (any-of)
            const adminContext: AuthContext = { ...defaultContext, roles: ["admin"] };
            await authContextStorage.run(adminContext, () => handler(req));
            assert.strictEqual(next.mock.calls.length, 1);

            // User without required role -> should be denied by default policy
            const viewerContext: AuthContext = { ...defaultContext, roles: ["viewer"] };
            const next2 = createMockNext();
            const handler2 = interceptor(next2);
            const req2 = createMockRequest();

            await assert.rejects(
                () => authContextStorage.run(viewerContext, () => handler2(req2)),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    return true;
                },
            );
        });

        it("should check scope requirements (all-of matching)", async () => {
            const rules: AuthzRule[] = [
                {
                    name: "read-write",
                    methods: ["*"],
                    effect: AuthzEffect.ALLOW,
                    requires: { scopes: ["read", "write"] },
                },
            ];

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules,
            });

            // User has both scopes -> should be allowed
            const fullContext: AuthContext = { ...defaultContext, scopes: ["read", "write", "delete"] };
            const next1 = createMockNext();
            const handler1 = interceptor(next1);
            const req1 = createMockRequest();

            await authContextStorage.run(fullContext, () => handler1(req1));
            assert.strictEqual(next1.mock.calls.length, 1);

            // User missing "write" scope -> denied by default policy
            const readOnlyContext: AuthContext = { ...defaultContext, scopes: ["read"] };
            const next2 = createMockNext();
            const handler2 = interceptor(next2);
            const req2 = createMockRequest();

            await assert.rejects(
                () => authContextStorage.run(readOnlyContext, () => handler2(req2)),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.PermissionDenied);
                    return true;
                },
            );
        });

        it("should skip authz for skipMethods", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
                skipMethods: ["test.Service/Method"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            // No AuthContext set, but method is skipped so no error
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should call programmatic authorize callback when no rules match", async () => {
            const authorize = mock.fn(
                async (context: AuthContext, _req: { service: string; method: string }) => {
                    return context.roles.includes("admin");
                },
            );

            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
                authorize: authorize as any,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await authContextStorage.run(defaultContext, () => handler(req));

            assert.strictEqual(authorize.mock.calls.length, 1);
            assert.strictEqual(next.mock.calls.length, 1);

            // Verify the callback receives correct arguments
            const callArgs = authorize.mock.calls[0]!.arguments;
            assert.strictEqual(callArgs[0].subject, "user-1");
            assert.strictEqual(callArgs[1].service, "test.Service");
            assert.strictEqual(callArgs[1].method, "Method");
        });

        it("should throw Unauthenticated when no AuthContext available", async () => {
            const interceptor = createAuthzInterceptor({
                defaultPolicy: AuthzEffect.DENY,
                rules: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.ok(err.message.includes("Authentication required"));
                    return true;
                },
            );
        });
    });
});
