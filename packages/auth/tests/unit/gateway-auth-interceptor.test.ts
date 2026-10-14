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
        // A gateway interceptor without a subject mapping could never build an identity, so the
        // factory fails at configuration time and names the offending option.
        for (const [label, subject] of [
            ["empty", ""],
            ["missing", undefined],
        ] as const) {
            it(`should throw naming headerMapping.subject when it is ${label}`, () => {
                assert.throws(
                    () => createGatewayAuthInterceptor({
                        ...DEFAULT_OPTIONS,
                        headerMapping: { ...DEFAULT_OPTIONS.headerMapping, subject: subject as unknown as string },
                    }),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.ok(err.message.includes("headerMapping.subject"), err.message);
                        return true;
                    },
                );
            });
        }

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

        // The guide: a trust header whose value matches none of the configured values is
        // Unauthenticated. The configured secret is "my-secret-123"; the near-misses below share a
        // prefix, extend it, differ in case, or differ in length, so only an exact comparison rejects all.
        for (const wrong of ["wrong-secret", "my-secret-12", "my-secret-1234", "my-secret-123 extra", "MY-SECRET-123", "y-secret-123", "x"]) {
            it(`should reject trust header value ${JSON.stringify(wrong)} and never run the handler`, async () => {
                const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
                const next = createMockNext();
                const handler = interceptor(next);

                const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
                req.header.set("x-gateway-secret", wrong);
                req.header.set("x-user-id", "user-1");

                await assert.rejects(
                    () => handler(req),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

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

        it("should prefer the type header over defaultType when the gateway sends one", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                defaultType: "custom-gateway",
            });

            let capturedContext: AuthContext | undefined;
            const handler = interceptor((async () => {
                capturedContext = getAuthContext();
                return { message: {} };
            }) as any);
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-auth-type", "oauth2");

            await handler(req);

            assert.strictEqual(capturedContext?.type, "oauth2");
        });

        // Every header the gateway contributes: all six mapped identity headers, the trust header
        // and a deployment-specific extra. The guide says they are deleted from the admitted
        // request, so the handler chain (next) must never observe any of them.
        const GATEWAY_HEADERS = {
            "x-gateway-secret": "my-secret-123",
            "x-user-id": "user-1",
            "x-user-name": "Test",
            "x-user-roles": '["admin"]',
            "x-user-scopes": "read write",
            "x-auth-type": "oauth2",
            "x-user-claims": '{"tenant":"acme"}',
            "x-custom-internal": "should-be-stripped",
        } as const;

        it("should delete every mapped header and the trust header before the handler chain runs", async () => {
            const interceptor = createGatewayAuthInterceptor({ ...DEFAULT_OPTIONS, stripHeaders: ["x-custom-internal"] });
            const seenByNext: Record<string, string | null> = {};
            const handler = interceptor((async (r: any) => {
                for (const name of Object.keys(GATEWAY_HEADERS)) seenByNext[name] = r.header.get(name);
                return { message: {} };
            }) as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            for (const [name, value] of Object.entries(GATEWAY_HEADERS)) req.header.set(name, value);

            await handler(req);

            for (const name of Object.keys(GATEWAY_HEADERS)) {
                assert.strictEqual(seenByNext[name], null, `${name} must already be absent while the handler chain runs`);
            }
        });

        it("should delete a header listed in stripHeaders before the handler chain runs", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                stripHeaders: ["x-custom-internal"],
            });
            let seenByNext: string | null = "unset";
            const handler = interceptor((async (r: any) => {
                seenByNext = r.header.get("x-custom-internal");
                return { message: {} };
            }) as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-custom-internal", "should-be-stripped");

            await handler(req);

            assert.strictEqual(seenByNext, null);
        });

        it("should keep an unlisted extra header untouched (stripHeaders is an explicit list)", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            let seenByNext: string | null = null;
            const handler = interceptor((async (r: any) => {
                seenByNext = r.header.get("x-custom-internal");
                return { message: {} };
            }) as any);

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "user-1");
            req.header.set("x-custom-internal", "keep-me");

            await handler(req);

            assert.strictEqual(seenByNext, "keep-me");
        });

        it("should skip auth for matching skipMethods, strip spoofed identity headers and leave other methods protected", async () => {
            const interceptor = createGatewayAuthInterceptor({
                ...DEFAULT_OPTIONS,
                skipMethods: ["test.Service/Method"],
            });
            let seenByNext: Record<string, string | null> = {};
            let contextInNext: AuthContext | undefined;
            const next = mock.fn(async (r: any) => {
                seenByNext = Object.fromEntries(Object.keys(GATEWAY_HEADERS).map((name) => [name, r.header.get(name)]));
                contextInNext = getAuthContext();
                return { message: {} };
            }) as any;
            const handler = interceptor(next);

            // A caller on a skipped method may still try to smuggle an identity in: the guide says
            // the mapped and trust headers are deleted on skipped methods too, and no identity is created.
            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-user-id", "spoofed-admin");
            req.header.set("x-user-roles", '["admin"]');
            req.header.set("x-gateway-secret", "attacker-guess");

            await handler(req);

            assert.strictEqual(next.mock.calls.length, 1);
            assert.strictEqual(contextInNext, undefined, "a skipped method must not receive an identity");
            for (const name of Object.keys(GATEWAY_HEADERS)) {
                assert.strictEqual(seenByNext[name], null, `${name} must be deleted on a skipped method`);
            }

            // Neighbours of the skipped method are still protected.
            for (const other of [
                { service: "test.Service", method: "OtherMethod" },
                { service: "other.Service", method: "Method" },
            ]) {
                const otherReq = createMockRequest(other);
                otherReq.header.set("x-user-id", "spoofed-admin");
                await assert.rejects(
                    () => handler(otherReq),
                    (err: unknown) => {
                        assertConnectError(err, Code.Unauthenticated);
                        return true;
                    },
                );
            }
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
            req.header.set("x-user-name", "Prop User");
            req.header.set("x-user-roles", '["admin"]');
            req.header.set("x-user-scopes", "read write");
            req.header.set("x-user-claims", '{"tenant":"acme"}');
            req.header.set("x-auth-type", "oauth2");

            await handler(req);

            // The verified identity is written back under the documented standard names.
            assert.strictEqual(req.header.get("x-auth-subject"), "prop-user");
            assert.strictEqual(req.header.get("x-auth-type"), "oauth2");
            assert.strictEqual(req.header.get("x-auth-name"), "Prop User");
            assert.strictEqual(req.header.get("x-auth-roles"), '["admin"]');
            assert.strictEqual(req.header.get("x-auth-scopes"), "read write");
            assert.strictEqual(req.header.get("x-auth-claims"), '{"tenant":"acme"}');
            // The gateway's own headers, trust secret included, are not restored.
            assert.strictEqual(req.header.get("x-gateway-secret"), null);
            assert.strictEqual(req.header.get("x-user-id"), null);
        });

        it("should not write x-auth-* identity headers by default", async () => {
            const interceptor = createGatewayAuthInterceptor(DEFAULT_OPTIONS);
            const handler = interceptor(createMockNext());

            const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
            req.header.set("x-gateway-secret", "my-secret-123");
            req.header.set("x-user-id", "prop-user");

            await handler(req);

            for (const name of ["x-auth-subject", "x-auth-type", "x-auth-name", "x-auth-roles", "x-auth-scopes", "x-auth-claims"]) {
                assert.strictEqual(req.header.get(name), null, `${name} must stay absent without propagateHeaders`);
            }
        });
    });
});
