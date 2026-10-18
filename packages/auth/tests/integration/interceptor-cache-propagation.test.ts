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
import { createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { LruCache } from "../../src/cache.ts";
import { parseAuthHeaders, setAuthHeaders } from "../../src/headers.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

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
            assert.strictEqual(req2.header.get("x-auth-subject"), "cached-user");
        });

        // The cache must not serve an identity past the credential's own expiry, even while the
        // cache entry's TTL is still running (session guide: the cache is bypassed once the
        // mapped expiresAt has passed). This is the negative pair of the case above: the long TTL
        // alone would serve the stale identity, so only the expiry check can force the re-verify.
        it("should re-verify instead of serving a cached identity whose expiresAt has passed", async () => {
            let verifyCount = 0;
            const interceptor = createAuthInterceptor({
                verifyCredentials: async (_cred: string): Promise<AuthContext> => {
                    verifyCount++;
                    return {
                        subject: "expired-user",
                        roles: [],
                        scopes: [],
                        claims: {},
                        type: "api-key",
                        expiresAt: new Date(Date.now() - 1_000),
                    };
                },
                cache: { ttl: 60_000 },
            });
            const next = mock.fn(async () => ({ message: {} }));
            const handler = interceptor(next as any);

            for (let call = 1; call <= 3; call++) {
                const h = new Headers();
                h.set("authorization", "Bearer token-expired");
                await handler(createMockRequest({ headers: h }));
                assert.strictEqual(verifyCount, call, `call ${call} must verify again`);
            }
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

            const call = async (token: string): Promise<void> => {
                const h = new Headers();
                h.set("authorization", `Bearer ${token}`);
                await handler(createMockRequest({ headers: h }));
            };

            // Fill the cache with a, b (oldest first), then read "a": it becomes the most recently used.
            await call("a");
            await call("b");
            assert.strictEqual(verifyCount, 2);
            await call("a");
            assert.strictEqual(verifyCount, 2, "a is served from the cache");

            // A third credential must evict the LEAST RECENTLY USED entry ("b"), not the oldest
            // inserted one ("a"): a first-in-first-out cache would drop "a" here.
            await call("c");
            assert.strictEqual(verifyCount, 3);

            await call("a");
            assert.strictEqual(verifyCount, 3, "a was used more recently than b and must survive the eviction");

            await call("b");
            assert.strictEqual(verifyCount, 4, "b was the least recently used entry and must have been evicted");
        });

        // A cache lifetime must be a positive number of milliseconds: zero and negative values
        // would make every entry already expired, and a non-number is a configuration mistake.
        // The error type and the "positive number" wording are what a caller sees.
        for (const [label, ttl] of [
            ["zero", 0],
            ["a negative number", -1],
            ["a numeric string", "1000"],
            ["undefined", undefined],
        ] as const) {
            it(`should throw RangeError for ttl ${label}`, () => {
                assert.throws(
                    () => new LruCache({ ttl: ttl as unknown as number }),
                    (err: unknown) => {
                        assert.ok(err instanceof RangeError);
                        assert.match((err as RangeError).message, /ttl must be a positive number/);
                        return true;
                    },
                );
            });
        }

        it("should accept the smallest positive ttl", () => {
            assert.doesNotThrow(() => new LruCache({ ttl: 1 }));
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

            // The wire form is fixed by the guide (names, JSON roles, space-separated scopes, JSON
            // claims), independently of the parser, so a format changed on both sides cannot hide.
            assert.deepStrictEqual(Object.fromEntries(headers), {
                "x-auth-subject": "rt-user",
                "x-auth-type": "jwt",
                "x-auth-name": "Round Trip",
                "x-auth-roles": '["admin","user"]',
                "x-auth-scopes": "read write",
                "x-auth-claims": '{"email":"rt@test.com","level":42}',
            });

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

        it("should return empty roles array for invalid JSON roles header", () => {
            const headers = new Headers();
            headers.set(AUTH_HEADERS.SUBJECT, "user-1");
            headers.set(AUTH_HEADERS.TYPE, "jwt");
            headers.set(AUTH_HEADERS.ROLES, "not-json");

            const parsed = parseAuthHeaders(headers);
            assert.ok(parsed);
            assert.deepStrictEqual(parsed.roles, []);
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
