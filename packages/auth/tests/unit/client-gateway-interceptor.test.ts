/**
 * Unit tests for the client-side gateway auth interceptor
 *
 * Tests createClientGatewayInterceptor() for header propagation,
 * roles serialization, and omission of optional headers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
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

            // The client guide's header table spells the names and the roles encoding out.
            assert.strictEqual(req.header.get("x-gateway-secret"), "gateway-secret-123");
            assert.strictEqual(req.header.get("x-auth-subject"), "order-service");
            assert.strictEqual(req.header.get("x-auth-roles"), '["service","order-writer"]');
            assert.strictEqual(next.mock.calls.length, 1);
        });

        // The guide pairs this client interceptor with createGatewayAuthInterceptor on the server and
        // warns that the server mapping must name the client's fixed headers (x-auth-subject,
        // x-auth-roles). The request the client prepares is handed to a real server interceptor here.
        describe("paired with createGatewayAuthInterceptor", () => {
            const SECRET = "pairing-secret";
            const serverFor = (headerMapping: { subject: string; roles: string }) =>
                createGatewayAuthInterceptor({ headerMapping, trustSource: { header: "x-gateway-secret", expectedValues: [SECRET] } });

            /** Send one request through the client interceptor into the server interceptor. */
            async function send(secret: string, serverMapping: { subject: string; roles: string }): Promise<AuthContext | undefined> {
                let seen: AuthContext | undefined;
                const server = serverFor(serverMapping)(async () => {
                    seen = getAuthContext();
                    return { message: {} } as never;
                });
                const client = createClientGatewayInterceptor({ secret, subject: "order-service", roles: ["service", "order-writer"] })((req) => server(req));
                await client(createMockRequest(MOCK_REQUEST_DEFAULTS));
                return seen;
            }

            it("admits the caller and hands its subject and roles to the handler when the mapping matches", async () => {
                const context = await send(SECRET, { subject: "x-auth-subject", roles: "x-auth-roles" });

                assert.strictEqual(context?.subject, "order-service");
                assert.deepStrictEqual(context?.roles, ["service", "order-writer"]);
            });

            it("is refused by the server when the secret is wrong", async () => {
                await assert.rejects(
                    () => send("another-secret", { subject: "x-auth-subject", roles: "x-auth-roles" }),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
            });

            it("is refused by the server when the mapping names other headers than the client sends", async () => {
                // The guide's warning: a server mapped to x-user-id never sees the client's x-auth-subject.
                await assert.rejects(
                    () => send(SECRET, { subject: "x-user-id", roles: "x-user-roles" }),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
            });
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
