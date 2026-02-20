/**
 * Integration tests for gateway-auth-interceptor advanced paths.
 *
 * Covers: CIDR trust matching, comma-separated roles fallback,
 * space-separated scopes, JSON claims parsing, oversized/invalid claims,
 * missing/optional fields, skipMethods strip, constructor validation,
 * custom stripHeaders.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { createMockRequest } from "../helpers/mock-request.ts";

/** Create a gateway auth interceptor with default header mapping. */
function createGateway(overrides?: Record<string, unknown>) {
    return createGatewayAuthInterceptor({
        headerMapping: {
            subject: "x-user-id",
            name: "x-user-name",
            roles: "x-user-roles",
            scopes: "x-user-scopes",
            type: "x-user-type",
            claims: "x-user-claims",
        },
        trustSource: {
            header: "x-gateway-secret",
            expectedValues: ["valid-secret"],
        },
        ...overrides,
    });
}

describe("Gateway Auth Advanced — Integration", () => {
    describe("CIDR trust matching", () => {
        it("should trust IP within CIDR range (10.0.0.5 in 10.0.0.0/8)", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/8"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "10.0.0.5");
            headers.set("x-user-id", "cidr-user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should reject IP outside CIDR range", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/8"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "192.168.1.1");
            headers.set("x-user-id", "outside-user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should match /0 CIDR (all IPs)", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["0.0.0.0/0"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "192.168.55.123");
            headers.set("x-user-id", "any-ip-user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should not match CIDR with prefix > 32", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/33"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "10.0.0.1");
            headers.set("x-user-id", "user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should not match CIDR with non-numeric prefix", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/abc"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "10.0.0.1");
            headers.set("x-user-id", "user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should not match when IP has non-4 octets", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/8"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "10.0.0"); // only 3 octets
            headers.set("x-user-id", "user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });

        it("should not match when IP has invalid octets > 255", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-forwarded-for",
                    expectedValues: ["10.0.0.0/8"],
                },
            });

            const headers = new Headers();
            headers.set("x-forwarded-for", "10.0.0.256");
            headers.set("x-user-id", "user");
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    return true;
                },
            );
        });
    });

    describe("header parsing", () => {
        it("should parse comma-separated roles fallback when JSON parse fails", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-roles", "admin, editor, viewer");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual([...captured.roles], ["admin", "editor", "viewer"]);
        });

        it("should parse space-separated scopes", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-scopes", "read write admin");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual([...captured.scopes], ["read", "write", "admin"]);
        });

        it("should parse JSON claims from header", async () => {
            const interceptor = createGateway();
            const claims = { email: "user@test.com", level: 5 };

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-claims", JSON.stringify(claims));

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual(captured.claims, claims);
        });

        it("should return empty claims for oversized claims header (>8192)", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-claims", JSON.stringify({ data: "x".repeat(9000) }));

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual(captured.claims, {});
        });

        it("should return empty claims for invalid JSON claims", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-claims", "not-json{");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual(captured.claims, {});
        });

        it("should return empty claims for non-object claims (array)", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-claims", "[1,2,3]");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual(captured.claims, {});
        });
    });

    describe("missing/optional fields", () => {
        it("should throw Unauthenticated when subject header is missing after trust", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            // No x-user-id
            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assert.ok(err instanceof ConnectError);
                    assert.strictEqual(err.code, Code.Unauthenticated);
                    assert.match(err.message, /Missing subject/);
                    return true;
                },
            );
        });

        it("should extract name from headerMapping", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-name", "John Doe");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.strictEqual(captured.name, "John Doe");
        });

        it("should use defaultType when type header is not present", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            // No x-user-type header

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.strictEqual(captured.type, "gateway"); // defaultType
        });

        it("should use type from header when provided", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-type", "oauth");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.strictEqual(captured.type, "oauth");
        });

        it("should use custom defaultType when configured", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["valid-secret"],
                },
                defaultType: "custom-gw",
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.strictEqual(captured.type, "custom-gw");
        });
    });

    describe("skipMethods + header stripping", () => {
        it("should strip gateway headers even for skipped methods", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: {
                    subject: "x-user-id",
                    roles: "x-user-roles",
                },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["valid-secret"],
                },
                skipMethods: ["test.v1.TestService/Health"],
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "spoofed-user");
            headers.set("x-user-roles", '["admin"]');
            const req = createMockRequest({ methodName: "Health", headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            // Gateway headers should be stripped to prevent spoofing
            assert.strictEqual(req.header.get("x-user-id"), null);
            assert.strictEqual(req.header.get("x-user-roles"), null);
            assert.strictEqual(req.header.get("x-gateway-secret"), null);
        });

        it("should strip custom headers from stripHeaders option", async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id" },
                trustSource: {
                    header: "x-gateway-secret",
                    expectedValues: ["valid-secret"],
                },
                stripHeaders: ["x-internal-trace", "x-custom-header"],
            });

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-internal-trace", "trace-123");
            headers.set("x-custom-header", "custom-value");

            const req = createMockRequest({ headers });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);
            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(req.header.get("x-internal-trace"), null);
            assert.strictEqual(req.header.get("x-custom-header"), null);
        });
    });

    describe("constructor validation", () => {
        it("should throw when subject mapping is missing", () => {
            assert.throws(
                () =>
                    createGatewayAuthInterceptor({
                        headerMapping: { subject: "" } as any,
                        trustSource: {
                            header: "x-gw",
                            expectedValues: ["secret"],
                        },
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /requires headerMapping\.subject/);
                    return true;
                },
            );
        });

        it("should throw when expectedValues is empty", () => {
            assert.throws(
                () =>
                    createGatewayAuthInterceptor({
                        headerMapping: { subject: "x-user-id" },
                        trustSource: {
                            header: "x-gw",
                            expectedValues: [],
                        },
                    }),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.match(err.message, /non-empty trustSource\.expectedValues/);
                    return true;
                },
            );
        });
    });

    describe("JSON array roles parsing", () => {
        it("should parse JSON array roles correctly", async () => {
            const interceptor = createGateway();

            const headers = new Headers();
            headers.set("x-gateway-secret", "valid-secret");
            headers.set("x-user-id", "user-1");
            headers.set("x-user-roles", '["admin","user"]');

            const req = createMockRequest({ headers });
            let captured: AuthContext | undefined;
            const next = mock.fn(async () => {
                captured = getAuthContext();
                return { message: {} };
            });

            const handler = interceptor(next as any);
            await handler(req);

            assert.ok(captured);
            assert.deepStrictEqual([...captured.roles], ["admin", "user"]);
        });
    });
});
