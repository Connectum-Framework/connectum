/**
 * Unit tests for gateway authentication interceptor
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import type { AuthContext, GatewayAuthInterceptorOptions } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

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

const DEFAULT_OPTIONS: GatewayAuthInterceptorOptions = {
    headerMapping: {
        subject: "x-user-id",
        name: "x-user-name",
        roles: "x-user-roles",
        scopes: "x-user-scopes",
        type: "x-auth-type",
        claims: "x-user-claims",
    },
    trustSource: {
        header: "x-gateway-secret",
        expectedValues: ["my-secret-123"],
    },
};

describe("gateway-auth-interceptor", () => {
    describe("createGatewayAuthInterceptor()", () => {
        it("should throw when headerMapping.subject is empty", () => {
            assert.throws(
                () => createGatewayAuthInterceptor({
                    ...DEFAULT_OPTIONS,
                    headerMapping: { ...DEFAULT_OPTIONS.headerMapping, subject: "" },
                }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("subject"));
                    return true;
                },
            );
        });

        it("should throw when expectedValues is empty", () => {
            assert.throws(
                () => createGatewayAuthInterceptor({
                    ...DEFAULT_OPTIONS,
                    trustSource: { header: "x-gateway-secret", expectedValues: [] },
                }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("expectedValues"));
                    return true;
                },
            );
        });

        it("should reject request without trust header", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.ok(err.message.includes("Untrusted"));
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should reject request with wrong trust header value", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-gateway-secret", "wrong-secret");
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should reject trusted request without subject header", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            // No subject header

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.ok(err.message.includes("subject"));
                    return true;
                },
            );
        });

        it("should extract auth context from trusted request", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-42");
            req.header.set("x-user-name", "John Doe");
            req.header.set("x-user-roles", '["admin","editor"]');
            req.header.set("x-user-scopes", "read write");
            req.header.set("x-auth-type", "oauth2");
            req.header.set("x-user-claims", '{"tenant":"acme"}');

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "user-42");
            assert.strictEqual(capturedContext.name, "John Doe");
            assert.deepStrictEqual(capturedContext.roles, ["admin", "editor"]);
            assert.deepStrictEqual(capturedContext.scopes, ["read", "write"]);
            assert.strictEqual(capturedContext.type, "oauth2");
            assert.deepStrictEqual(capturedContext.claims, { tenant: "acme" });
        });

        it("should parse comma-separated roles", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-user-roles", "admin, editor, viewer");

            await handler(req);

            assert.ok(capturedContext);
            assert.deepStrictEqual(capturedContext.roles, ["admin", "editor", "viewer"]);
        });

        it("should use defaultType when type header is missing", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                defaultType: "custom-gateway",
            });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.type, "custom-gateway");
        });

        it("should strip mapped headers after extraction", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-user-name", "Test");

            await handler(req);

            // All mapped headers should be stripped
            assert.strictEqual(req.header.get("x-gateway-secret"), null);
            assert.strictEqual(req.header.get("x-user-id"), null);
            assert.strictEqual(req.header.get("x-user-name"), null);
        });

        it("should strip custom headers from stripHeaders option", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                stripHeaders: ["x-custom-internal"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-custom-internal", "should-be-stripped");

            await handler(req);

            assert.strictEqual(req.header.get("x-custom-internal"), null);
        });

        it("should skip auth for matching skipMethods", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                skipMethods: ["test.Service/Method"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            // No trust header, no subject — should still pass

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should trust CIDR ranges in expectedValues", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                trustSource: {
                    header: "x-real-ip",
                    expectedValues: ["10.0.0.0/8"],
                },
            });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("x-real-ip", "10.255.128.42");
            req.header.set("x-user-id", "cidr-user");

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "cidr-user");
        });

        it("should reject IP outside CIDR range", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                trustSource: {
                    header: "x-real-ip",
                    expectedValues: ["10.0.0.0/8"],
                },
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-real-ip", "192.168.1.1");
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should set auth context in AsyncLocalStorage", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "als-user");

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "als-user");
        });

        it("should propagate headers when propagateHeaders is true", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                propagateHeaders: true,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest();
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "prop-user");
            req.header.set("x-user-roles", '["admin"]');

            await handler(req);

            // Standard auth headers should be set
            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "prop-user");
            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), JSON.stringify(["admin"]));
        });
    });
});
