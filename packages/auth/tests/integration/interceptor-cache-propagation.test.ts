/**
 * Integration tests for cache behaviour through interceptor chains
 * and header propagation pipeline (setAuthHeaders → parseAuthHeaders).
 *
 * Covers: LRU cache hit/miss, TTL expiry, LRU eviction, RangeError,
 * session cache with propagatedClaims, full header round-trip,
 * oversized/invalid headers, propagatedClaims filtering.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { LruCache } from "../../src/cache.ts";
import { parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";
import { createMockRequest } from "../helpers/mock-request.ts";

describe("Interceptor Cache & Propagation — Integration", () => {
    describe("cache via createAuthInterceptor", () => {
        it("should serve from cache on second call with valid expiresAt", async () => {
            let verifyCount = 0;
            const interceptor = createAuthInterceptor({
                verifyCredentials: async (_cred: string): Promise<AuthContext> => {
                    verifyCount++;
                    return {
                        subject: "cached-user",
                        roles: ["user"],
                        scopes: [],
                        claims: {},
                        type: "api-key",
                        expiresAt: new Date(Date.now() + 60_000),
                    };
                },
                cache: { ttl: 60_000 },
                propagateHeaders: true,
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            // First call — verifies
            const h1 = new Headers();
            h1.set("authorization", "Bearer token-a");
            await handler(createMockRequest({ headers: h1 }));
            assert.strictEqual(verifyCount, 1);

            // Second call — cache hit (expiresAt is in the future)
            const h2 = new Headers();
            h2.set("authorization", "Bearer token-a");
            const req2 = createMockRequest({ headers: h2 });
            await handler(req2);
            assert.strictEqual(verifyCount, 1); // still 1
            assert.strictEqual(next.mock.calls.length, 2);
            // propagateHeaders was set on cached path
            assert.strictEqual(req2.header.get(AUTH_HEADERS.SUBJECT), "cached-user");
        });

        it("should re-verify after cache TTL expiry", async () => {
            let verifyCount = 0;
            const interceptor = createAuthInterceptor({
                verifyCredentials: async (_cred: string): Promise<AuthContext> => {
                    verifyCount++;
                    return {
                        subject: "ttl-user",
                        roles: [],
                        scopes: [],
                        claims: {},
                        type: "key",
                    };
                },
                cache: { ttl: 1 }, // 1ms TTL
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            const h1 = new Headers();
            h1.set("authorization", "Bearer ttl-token");
            await handler(createMockRequest({ headers: h1 }));
            assert.strictEqual(verifyCount, 1);

            // Wait for TTL to expire
            await new Promise((r) => setTimeout(r, 10));

            const h2 = new Headers();
            h2.set("authorization", "Bearer ttl-token");
            await handler(createMockRequest({ headers: h2 }));
            assert.strictEqual(verifyCount, 2); // re-verified
        });

        it("should evict LRU entry when maxSize is exceeded", async () => {
            let verifyCount = 0;
            const interceptor = createAuthInterceptor({
                verifyCredentials: async (_cred: string): Promise<AuthContext> => {
                    verifyCount++;
                    return {
                        subject: `user-${verifyCount}`,
                        roles: [],
                        scopes: [],
                        claims: {},
                        type: "key",
                    };
                },
                cache: { ttl: 60_000, maxSize: 2 },
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            // Fill cache with 2 entries
            for (const token of ["a", "b"]) {
                const h = new Headers();
                h.set("authorization", `Bearer ${token}`);
                await handler(createMockRequest({ headers: h }));
            }
            assert.strictEqual(verifyCount, 2);

            // Third entry evicts "a"
            const h3 = new Headers();
            h3.set("authorization", "Bearer c");
            await handler(createMockRequest({ headers: h3 }));
            assert.strictEqual(verifyCount, 3);

            // "a" should be evicted — verify again (adds "a", evicts "b" since cache is full)
            const h4 = new Headers();
            h4.set("authorization", "Bearer a");
            await handler(createMockRequest({ headers: h4 }));
            assert.strictEqual(verifyCount, 4); // re-verified

            // "c" should still be cached (was accessed more recently than "b")
            const h5 = new Headers();
            h5.set("authorization", "Bearer c");
            await handler(createMockRequest({ headers: h5 }));
            assert.strictEqual(verifyCount, 4); // still 4 — cached
        });

        it("should throw RangeError for ttl <= 0", () => {
            assert.throws(
                () => new LruCache({ ttl: 0 }),
                (err: unknown) => {
                    assert.ok(err instanceof RangeError);
                    assert.match((err as RangeError).message, /ttl must be a positive number/);
                    return true;
                },
            );

            assert.throws(
                () => new LruCache({ ttl: -1 }),
                (err: unknown) => {
                    assert.ok(err instanceof RangeError);
                    return true;
                },
            );
        });
    });

    describe("cache via createSessionAuthInterceptor", () => {
        it("should cache session and propagate headers with propagatedClaims", async () => {
            const verifySession = mock.fn(async () => ({ userId: "s1", email: "a@b.com" }));

            const interceptor = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: (session: unknown) => {
                    const s = session as { userId: string; email: string };
                    return {
                        subject: s.userId,
                        roles: ["user"],
                        scopes: [],
                        claims: { email: s.email, internal: "secret" },
                        type: "session",
                    };
                },
                cache: { ttl: 60_000 },
                propagateHeaders: true,
                propagatedClaims: ["email"], // only email, not internal
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            // First call — verifies
            const h1 = new Headers();
            h1.set("authorization", "Bearer sess-token");
            const req1 = createMockRequest({ headers: h1 });
            await handler(req1);
            assert.strictEqual(verifySession.mock.calls.length, 1);
            // Claims header should contain only "email"
            const claimsStr = req1.header.get(AUTH_HEADERS.CLAIMS);
            assert.ok(claimsStr);
            const parsedClaims = JSON.parse(claimsStr);
            assert.strictEqual(parsedClaims.email, "a@b.com");
            assert.strictEqual(parsedClaims.internal, undefined); // filtered

            // Second call — cache hit, same propagation
            const h2 = new Headers();
            h2.set("authorization", "Bearer sess-token");
            const req2 = createMockRequest({ headers: h2 });
            await handler(req2);
            assert.strictEqual(verifySession.mock.calls.length, 1); // still 1

            const claimsStr2 = req2.header.get(AUTH_HEADERS.CLAIMS);
            assert.ok(claimsStr2);
            const parsedClaims2 = JSON.parse(claimsStr2);
            assert.strictEqual(parsedClaims2.email, "a@b.com");
            assert.strictEqual(parsedClaims2.internal, undefined);
        });

        it("should re-verify session after TTL expiry", async () => {
            const verifySession = mock.fn(async () => ({ userId: "s2" }));

            const interceptor = createSessionAuthInterceptor({
                verifySession: verifySession as any,
                mapSession: () => ({
                    subject: "s2",
                    roles: [],
                    scopes: [],
                    claims: {},
                    type: "session",
                }),
                cache: { ttl: 1 }, // 1ms
            });

            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            const h1 = new Headers();
            h1.set("authorization", "Bearer sess-ttl");
            await handler(createMockRequest({ headers: h1 }));
            assert.strictEqual(verifySession.mock.calls.length, 1);

            await new Promise((r) => setTimeout(r, 10));

            const h2 = new Headers();
            h2.set("authorization", "Bearer sess-ttl");
            await handler(createMockRequest({ headers: h2 }));
            assert.strictEqual(verifySession.mock.calls.length, 2);
        });
    });

    describe("header round-trip (setAuthHeaders → parseAuthHeaders)", () => {
        it("should round-trip full AuthContext through headers", () => {
            const original: AuthContext = {
                subject: "rt-user",
                name: "Round Trip",
                roles: ["admin", "user"],
                scopes: ["read", "write"],
                claims: { email: "rt@test.com", level: 42 },
                type: "jwt",
            };

            const headers = new Headers();
            setAuthHeaders(headers, original);
            const parsed = parseAuthHeaders(headers);

            assert.ok(parsed);
            assert.strictEqual(parsed.subject, "rt-user");
            assert.strictEqual(parsed.name, "Round Trip");
            assert.strictEqual(parsed.type, "jwt");
            assert.deepStrictEqual([...parsed.roles], ["admin", "user"]);
            assert.deepStrictEqual([...parsed.scopes], ["read", "write"]);
            assert.strictEqual((parsed.claims as any).email, "rt@test.com");
            assert.strictEqual((parsed.claims as any).level, 42);
        });

        it("should return undefined when subject header is missing", () => {
            const headers = new Headers();
            const parsed = parseAuthHeaders(headers);
            assert.strictEqual(parsed, undefined);
        });

        it("should default type to 'unknown' when type header is missing", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            // Do NOT set AUTH_HEADERS.TYPE
            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.strictEqual(parsed.type, "unknown");
        });

        it("should return empty roles array when roles header exceeds 8192 bytes", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            // Create oversized roles string (>8192)
            const oversizedRoles = JSON.stringify(Array.from({ length: 2000 }, (_, i) => `role-${i}-${"x".repeat(10)}`));
            assert.ok(oversizedRoles.length > 8192);
            headers.set(AUTH_HEADERS.ROLES, oversizedRoles);

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.roles, []);
        });

        it("should return empty roles array for invalid JSON roles header", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.ROLES, "not-json");

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.roles, []);
        });

        it("should return empty claims object for oversized claims header", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            // Create oversized claims string (>8192)
            const oversizedClaims = JSON.stringify({ data: "x".repeat(9000) });
            assert.ok(oversizedClaims.length > 8192);
            headers.set(AUTH_HEADERS.CLAIMS, oversizedClaims);

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.claims, {});
        });

        it("should return empty claims object for invalid JSON claims header", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.CLAIMS, "invalid-json{");

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.claims, {});
        });

        it("should return empty claims object for array JSON claims (non-object)", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.CLAIMS, "[1,2,3]");

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.claims, {});
        });
    });

    describe("setAuthHeaders overflow handling", () => {
        it("should not set roles header when serialized roles exceeds 8192 bytes", () => {
            const headers = new Headers();
            const oversizedRoles = Array.from({ length: 2000 }, (_, i) => `role-${i}-${"x".repeat(10)}`);
            const ctx: AuthContext = {
                subject: "user-1",
                roles: oversizedRoles,
                scopes: [],
                claims: {},
                type: "jwt",
            };
            setAuthHeaders(headers, ctx);

            assert.strictEqual(headers.get(AUTH_HEADERS.SUBJECT), "user-1");
            assert.strictEqual(headers.get(AUTH_HEADERS.ROLES), null); // not set
        });

        it("should not set scopes header when serialized scopes exceeds 8192 bytes", () => {
            const headers = new Headers();
            const oversizedScopes = Array.from({ length: 2000 }, (_, i) => `scope-${i}-${"x".repeat(10)}`);
            const ctx: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: oversizedScopes,
                claims: {},
                type: "jwt",
            };
            setAuthHeaders(headers, ctx);

            assert.strictEqual(headers.get(AUTH_HEADERS.SCOPES), null); // not set
        });

        it("should not set claims header when serialized claims exceeds 8192 bytes", () => {
            const headers = new Headers();
            const ctx: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: { data: "x".repeat(9000) },
                type: "jwt",
            };
            setAuthHeaders(headers, ctx);

            assert.strictEqual(headers.get(AUTH_HEADERS.CLAIMS), null); // not set
        });

        it("should filter claims via propagatedClaims", () => {
            const headers = new Headers();
            const ctx: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: { email: "a@b.com", secret: "hidden" },
                type: "jwt",
            };
            setAuthHeaders(headers, ctx, ["email"]);

            const claimsStr = headers.get(AUTH_HEADERS.CLAIMS);
            assert.ok(claimsStr);
            const parsed = JSON.parse(claimsStr);
            assert.strictEqual(parsed.email, "a@b.com");
            assert.strictEqual(parsed.secret, undefined);
        });

        it("should not set claims header when propagatedClaims filters everything out", () => {
            const headers = new Headers();
            const ctx: AuthContext = {
                subject: "user-1",
                roles: [],
                scopes: [],
                claims: { secret: "hidden" },
                type: "jwt",
            };
            setAuthHeaders(headers, ctx, ["nonexistent"]);

            assert.strictEqual(headers.get(AUTH_HEADERS.CLAIMS), null);
        });
    });
});
