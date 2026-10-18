/**
 * Unit tests for the generic authentication interceptor
 *
 * Tests createAuthInterceptor() for credential extraction, verification,
 * skip patterns, context propagation, and error handling.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import type { AuthContext } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

describe("auth-interceptor", () => {
    describe("createAuthInterceptor()", () => {
        it("should extract Bearer token and call verifyCredentials", async () => {
            const expectedContext: AuthContext = {
                subject: "user-1",
                roles: ["admin"],
                scopes: ["read"],
                claims: {},
                type: "jwt",
            };

            const verifyCredentials = mock.fn(async (token: string) => {
                assert.strictEqual(token, "my-token-123");
                return expectedContext;
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer my-token-123");

            await handler(req);

            assert.strictEqual(verifyCredentials.mock.calls.length, 1);
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it("should throw Unauthenticated when no Authorization header", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated);
                    return true;
                },
            );

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 0);
        });

        it("should throw Unauthenticated when verifyCredentials throws", async () => {
            const verifyCredentials = mock.fn(async () => {
                throw new Error("Invalid token");
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer bad-token");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                    return true;
                },
            );
        });

        it("should pass through ConnectError from verifyCredentials", async () => {
            const verifyCredentials = mock.fn(async () => {
                throw new ConnectError("Token expired", Code.PermissionDenied);
            });

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer expired-token");

            await assert.rejects(
                () => handler(req),
                (err: unknown) => {
                    assertConnectError(err, Code.PermissionDenied, "Token expired");
                    return true;
                },
            );
        });

        it("should skip auth for matching skipMethods patterns (exact)", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({
                verifyCredentials: verifyCredentials as any,
                skipMethods: ["test.Service/Method"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);

            await handler(req);

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 1);

            // An exact entry names one method: a sibling method of the same service and the
            // same method name on another service both still demand credentials.
            for (const other of [
                { service: "test.Service", method: "OtherMethod" },
                { service: "other.Service", method: "Method" },
            ]) {
                await assert.rejects(
                    () => handler(createMockRequest(other)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                    `${other.service}/${other.method} must not be skipped`,
                );
            }
            assert.strictEqual(next.mock.calls.length, 1, "a method outside skipMethods must not reach next");
        });

        it("should skip auth for matching skipMethods patterns (wildcard)", async () => {
            const verifyCredentials = mock.fn(async () => ({
                subject: "user",
                roles: [],
                scopes: [],
                claims: {},
                type: "test",
            }));

            const interceptor = createAuthInterceptor({
                verifyCredentials: verifyCredentials as any,
                skipMethods: ["test.Service/*"],
            });
            const next = createMockNext();
            const handler = interceptor(next);

            await handler(createMockRequest(MOCK_REQUEST_DEFAULTS));
            await handler(createMockRequest({ service: "test.Service", method: "AnotherMethod" }));

            assert.strictEqual(verifyCredentials.mock.calls.length, 0);
            assert.strictEqual(next.mock.calls.length, 2);

            // `Service/*` covers every method of that one service only: the same method name on
            // another service, and a service whose name merely starts with the pattern's, still
            // demand credentials.
            for (const other of [
                { service: "other.Service", method: "Method" },
                { service: "test.ServiceExtended", method: "Method" },
            ]) {
                await assert.rejects(
                    () => handler(createMockRequest(other)),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                    `${other.service}/${other.method} must not be skipped`,
                );
            }
            assert.strictEqual(next.mock.calls.length, 2, "a method outside the service wildcard must not reach next");
        });

        it("should set auth context in AsyncLocalStorage", async () => {
            const expectedContext: AuthContext = {
                subject: "als-user",
                roles: ["viewer"],
                scopes: ["read"],
                claims: { custom: true },
                type: "jwt",
            };

            const verifyCredentials = mock.fn(async () => expectedContext);

            const interceptor = createAuthInterceptor({ verifyCredentials: verifyCredentials as any });

            let capturedContext: AuthContext | undefined;
            const next = mock.fn(async (_req: any) => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any;

            const handler = interceptor(next);
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer test-token");

            await handler(req);

            assert.ok(capturedContext);
            assert.strictEqual(capturedContext.subject, "als-user");
            assert.deepStrictEqual(capturedContext.roles, ["viewer"]);
            assert.deepStrictEqual(capturedContext.claims, { custom: true });
        });

        // Header names and encodings are the documented wire contract of the auth context guide
        // (x-auth-subject, x-auth-type, x-auth-name, x-auth-roles as JSON, x-auth-scopes
        // space-separated, x-auth-claims as JSON), so they are spelled out, not read from the
        // implementation's constants.
        const propagationContext: AuthContext = {
            subject: "propagated-user",
            name: "Alice Example",
            roles: ["admin", "editor"],
            scopes: ["write", "read"],
            claims: { org: "acme" },
            type: "jwt",
        };

        it("should write the documented identity headers when propagateHeaders is true", async () => {
            const interceptor = createAuthInterceptor({
                verifyCredentials: (async () => propagationContext) as any,
                propagateHeaders: true,
            });
            const handler = interceptor(createMockNext());

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer test-token");

            await handler(req);

            assert.strictEqual(req.header.get("x-auth-subject"), "propagated-user");
            assert.strictEqual(req.header.get("x-auth-type"), "jwt");
            assert.strictEqual(req.header.get("x-auth-name"), "Alice Example");
            assert.strictEqual(req.header.get("x-auth-roles"), '["admin","editor"]');
            assert.strictEqual(req.header.get("x-auth-scopes"), "write read");
            assert.strictEqual(req.header.get("x-auth-claims"), '{"org":"acme"}');
        });

        it("should not write identity headers by default", async () => {
            const interceptor = createAuthInterceptor({
                verifyCredentials: (async () => propagationContext) as any,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("authorization", "Bearer test-token");

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            for (const name of ["x-auth-subject", "x-auth-type", "x-auth-name", "x-auth-roles", "x-auth-scopes", "x-auth-claims"]) {
                assert.strictEqual(req.header.get(name), null, `${name} must stay absent unless propagateHeaders is enabled`);
            }
        });
    });
});
