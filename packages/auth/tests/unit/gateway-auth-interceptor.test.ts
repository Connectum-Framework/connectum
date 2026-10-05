/**
 * Unit tests for gateway authentication interceptor
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import type { AuthContext, GatewayAuthInterceptorOptions } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Untrusted");
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should reject request with wrong trust header value", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "wrong-secret");
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should reject trusted request without subject header", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "my-secret-123");
            // No subject header

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "subject");
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
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-real-ip", "192.168.1.1");
            req.header.set("x-user-id", "user-1");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should match every CIDR prefix length exactly at the range boundaries", async () => {
            // Expected values follow RFC 4632 prefix semantics: an address is inside
            // a/N when its first N bits equal the network's first N bits. Addresses
            // above 127.255.255.255 and /0, /1, /31, /32 are where signed 32-bit
            // arithmetic goes wrong, so they are covered explicitly.
            const cases: ReadonlyArray<readonly [cidr: string, ip: string, trusted: boolean]> = [
                ["192.168.1.0/24", "192.168.1.0", true],
                ["192.168.1.0/24", "192.168.1.255", true],
                ["192.168.1.0/24", "192.168.2.0", false],
                ["192.168.1.0/24", "192.168.0.255", false],
                ["128.0.0.0/1", "128.0.0.0", true],
                ["128.0.0.0/1", "255.255.255.255", true],
                ["128.0.0.0/1", "127.255.255.255", false],
                ["128.0.0.0/1", "0.0.0.0", false],
                ["192.168.1.5/32", "192.168.1.5", true],
                ["192.168.1.5/32", "192.168.1.4", false],
                ["192.168.1.5/32", "192.168.1.6", false],
                ["192.168.1.4/31", "192.168.1.4", true],
                ["192.168.1.4/31", "192.168.1.5", true],
                ["192.168.1.4/31", "192.168.1.6", false],
                ["192.168.1.4/31", "192.168.1.3", false],
                ["0.0.0.0/0", "255.255.255.255", true],
                ["0.0.0.0/0", "1.2.3.4", true],
                ["172.16.0.0/12", "172.31.255.255", true],
                ["172.16.0.0/12", "172.32.0.0", false],
                ["172.16.0.0/12", "172.15.255.255", false],
                ["10.1.2.3/8", "10.9.9.9", true],
                ["10.1.2.3/8", "11.0.0.0", false],
                ["255.255.255.255/32", "255.255.255.255", true],
                ["255.255.255.255/32", "255.255.255.254", false],
            ];

            for (const [cidr, ip, trusted] of cases) {
                const interceptor = createGatewayAuthInterceptor({
                    ...DEFAULT_OPTIONS,
                    trustSource: { header: "x-real-ip", expectedValues: [cidr] },
                });
                const next = mock.fn(async (_req: any) => ({ message: {} })) as any;
                const handler = interceptor(next);
                const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
                req.header.set("x-real-ip", ip);
                req.header.set("x-user-id", "cidr-user");

                if (trusted) {
                    await handler(req);
                    assert.strictEqual(next.mock.calls.length, 1, `${ip} must be inside ${cidr}`);
                } else {
                    await assert.rejects(
                        () => handler(req),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated);
                            return true;
                        },
                        `${ip} must be outside ${cidr}`,
                    );
                }
            }
        });

        it("should set auth context in AsyncLocalStorage", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
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
