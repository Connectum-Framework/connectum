/**
 * Unit tests for the client-side gateway auth interceptor
 *
 * Tests createClientGatewayInterceptor() for header propagation,
 * roles serialization, and omission of optional headers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

describe("client-gateway-interceptor", () => {
    describe("createClientGatewayInterceptor()", () => {
        it("should set all three headers (secret, subject, roles)", async () => {
            const interceptor = createClientGatewayInterceptor({
                secret: "gateway-secret-123",
                subject: "order-service",
                roles: ["service", "order-writer"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(req.header.get("x-gateway-secret"), "gateway-secret-123");
            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "order-service");
            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), JSON.stringify(["service", "order-writer"]));
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should JSON.stringify the roles array", async () => {
            const interceptor = createClientGatewayInterceptor({
                secret: "secret",
                subject: "svc",
                roles: ["admin", "user", "editor"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            const rolesHeader = req.header.get(AUTH_HEADERS.ROLES);
            assert.ok(rolesHeader);
            const parsed: unknown = JSON.parse(rolesHeader);
            assert.deepStrictEqual(parsed, ["admin", "user", "editor"]);
        });

        it("should not set x-auth-roles header when roles are not provided", async () => {
            const interceptor = createClientGatewayInterceptor({
                secret: "gateway-secret",
                subject: "user-service",
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(req.header.get("x-gateway-secret"), "gateway-secret");
            assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "user-service");
            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), null);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should not set x-auth-roles header when roles array is empty", async () => {
            const interceptor = createClientGatewayInterceptor({
                secret: "gateway-secret",
                subject: "user-service",
                roles: [],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(req.header.get(AUTH_HEADERS.ROLES), null);
            assert.strictEqual(next.mock.calls.length, 1);
        });
    });
});
