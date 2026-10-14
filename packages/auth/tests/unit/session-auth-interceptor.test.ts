/**
 * Unit tests for session-based authentication interceptor
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { getAuthContext } from "../../src/context.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";

const MOCK_REQUEST_DEFAULTS = { service: "test.Service", method: "Method" } as const;

const MOCK_SESSION = {
	user: { id: "user-42", name: "John Doe", email: "john@example.com" },
	expiresAt: new Date(Date.now() + 3600_000),
};

const MOCK_MAP_SESSION = (session: unknown): AuthContext => {
	const s = session as typeof MOCK_SESSION;
	return {
		subject: s.user.id,
		name: s.user.name,
		roles: [],
		scopes: [],
		claims: s.user as unknown as Record<string, unknown>,
		type: "session",
	};
};

describe("session-auth-interceptor", () => {
	describe("createSessionAuthInterceptor()", () => {
		it("should verify session and set auth context", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
			});

			let capturedContext: AuthContext | undefined;
			const next = mock.fn(async (_req: any) => {
				capturedContext = getAuthContext();
				return { message: {} };
			}) as any;

			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer session-token-123");

			await handler(req);

			assert.ok(capturedContext);
			assert.strictEqual(capturedContext.subject, "user-42");
			assert.strictEqual(capturedContext.name, "John Doe");
			assert.strictEqual(capturedContext.type, "session");
			assert.strictEqual(verifySession.mock.calls.length, 1);
		});

		it("should pass full headers to verifySession", async () => {
			let capturedHeaders: Headers | undefined;
			const verifySession = mock.fn(async (_token: string, headers: Headers) => {
				capturedHeaders = headers;
				return MOCK_SESSION;
			});

			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
			});

			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer session-token");
			req.header.set("cookie", "session_id=abc123");

			await handler(req);

			assert.ok(capturedHeaders);
			assert.strictEqual(capturedHeaders.get("cookie"), "session_id=abc123");
		});

		it("should throw when no credentials provided", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
			});

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
			assert.strictEqual(verifySession.mock.calls.length, 0);
		});

		it("should throw when session verification fails", async () => {
			const verifySession = mock.fn(async () => {
				throw new Error("Session expired");
			});

			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
			});

			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer bad-token");

			await assert.rejects(
				() => handler(req),
				(err: unknown) => {
					assertConnectError(err, Code.Unauthenticated, "Session verification failed");
					return true;
				},
			);
		});

		it("should pass through ConnectError from verifySession", async () => {
			const verifySession = mock.fn(async () => {
				throw new ConnectError("Custom session error", Code.PermissionDenied);
			});

			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
			});

			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer token");

			await assert.rejects(
				() => handler(req),
				(err: unknown) => {
					assertConnectError(err, Code.PermissionDenied);
					return true;
				},
			);
		});

		it("should skip auth for matching skipMethods", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				skipMethods: ["test.Service/Method"],
			});

			let identityHeaderSeenByNext: string | null = "unset";
			let contextSeenByNext: AuthContext | undefined;
			const next = mock.fn(async (r: any) => {
				identityHeaderSeenByNext = r.header.get("x-auth-subject");
				contextSeenByNext = getAuthContext();
				return { message: {} };
			}) as any;
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			// A client-supplied identity header must not survive on a skipped method either.
			req.header.set("x-auth-subject", "spoofed-admin");

			await handler(req);

			assert.strictEqual(next.mock.calls.length, 1);
			assert.strictEqual(verifySession.mock.calls.length, 0);
			assert.strictEqual(identityHeaderSeenByNext, null, "the spoofed identity header must be removed before the handler chain");
			assert.strictEqual(contextSeenByNext, undefined, "a skipped method gets no identity");

			// Everything outside skipMethods still needs credentials and never reaches the backend or the handler.
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
			assert.strictEqual(next.mock.calls.length, 1);
			assert.strictEqual(verifySession.mock.calls.length, 0);
		});

		it("should use cache when configured", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				cache: { ttl: 60_000 },
			});

			const next = createMockNext();
			const handler = interceptor(next);

			// First request — should call verifySession
			const req1 = createMockRequest();
			req1.header.set("authorization", "Bearer cached-token");
			await handler(req1);
			assert.strictEqual(verifySession.mock.calls.length, 1);

			// Second request — should use cache
			const req2 = createMockRequest();
			req2.header.set("authorization", "Bearer cached-token");
			await handler(req2);
			assert.strictEqual(verifySession.mock.calls.length, 1); // Still 1
		});

		// The guide: cached identities are keyed by the extracted session token. Two callers with
		// different tokens must each get their own identity, never the other's.
		it("should cache per session token and never serve one caller the identity cached for another", async () => {
			const sessions: Record<string, typeof MOCK_SESSION> = {
				"token-alice": { ...MOCK_SESSION, user: { id: "alice", name: "Alice", email: "alice@example.com" } },
				"token-bob": { ...MOCK_SESSION, user: { id: "bob", name: "Bob", email: "bob@example.com" } },
			};
			const verifySession = mock.fn(async (token: string) => sessions[token]);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				cache: { ttl: 60_000 },
			});

			const subjectSeenFor = async (token: string): Promise<string | undefined> => {
				let seen: string | undefined;
				const handler = interceptor((async () => {
					seen = getAuthContext()?.subject;
					return { message: {} };
				}) as any);
				const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
				req.header.set("authorization", `Bearer ${token}`);
				await handler(req);
				return seen;
			};

			assert.strictEqual(await subjectSeenFor("token-alice"), "alice");
			assert.strictEqual(await subjectSeenFor("token-bob"), "bob", "bob must not receive alice's cached identity");
			assert.strictEqual(await subjectSeenFor("token-alice"), "alice");
			assert.strictEqual(await subjectSeenFor("token-bob"), "bob");
			// Each token was verified once; the repeats were served from the cache.
			assert.strictEqual(verifySession.mock.calls.length, 2);
		});

		it("should verify again once the cache ttl has elapsed", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				cache: { ttl: 60_000 },
			});
			const handler = interceptor(createMockNext());
			const call = async () => {
				const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
				req.header.set("authorization", "Bearer ttl-token");
				await handler(req);
			};

			const originalNow = Date.now;
			let currentTime = originalNow();
			Date.now = () => currentTime;
			try {
				await call();
				currentTime += 59_000;
				await call();
				assert.strictEqual(verifySession.mock.calls.length, 1, "still inside the ttl: served from the cache");

				currentTime += 2_000;
				await call();
				assert.strictEqual(verifySession.mock.calls.length, 2, "past the ttl: the backend is asked again");
			} finally {
				Date.now = originalNow;
			}
		});

		it("should bypass the cache once the mapped identity's own expiresAt has passed", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const originalNow = Date.now;
			let currentTime = originalNow();
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				// The identity expires in 30 s, well before the 10-minute cache ttl.
				mapSession: (session) => ({ ...MOCK_MAP_SESSION(session), expiresAt: new Date(currentTime + 30_000) }),
				cache: { ttl: 600_000 },
			});
			const handler = interceptor(createMockNext());
			const call = async () => {
				const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
				req.header.set("authorization", "Bearer expiring-token");
				await handler(req);
			};

			Date.now = () => currentTime;
			try {
				await call();
				currentTime += 10_000;
				await call();
				assert.strictEqual(verifySession.mock.calls.length, 1, "identity still valid: cached");

				currentTime += 30_000;
				await call();
				assert.strictEqual(verifySession.mock.calls.length, 2, "identity expired: the cached copy must not be reused");
			} finally {
				Date.now = originalNow;
			}
		});

		it("should use custom extractToken", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				extractToken: (req) => req.header.get("x-session-token"),
			});

			let capturedContext: AuthContext | undefined;
			const next = mock.fn(async (_req: any) => {
				capturedContext = getAuthContext();
				return { message: {} };
			}) as any;

			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("x-session-token", "custom-token-456");

			await handler(req);

			assert.ok(capturedContext);
			assert.strictEqual(capturedContext.subject, "user-42");
		});

		it("should propagate headers when enabled", async () => {
			const verifySession = mock.fn(async () => MOCK_SESSION);
			const interceptor = createSessionAuthInterceptor({
				verifySession: verifySession as any,
				mapSession: MOCK_MAP_SESSION,
				propagateHeaders: true,
			});

			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer token");

			await handler(req);

			// Documented header names of the auth context guide, spelled out rather than read from the implementation.
			assert.strictEqual(req.header.get("x-auth-subject"), "user-42");
			assert.strictEqual(req.header.get("x-auth-type"), "session");
			assert.strictEqual(req.header.get("x-auth-name"), "John Doe");
		});

		it("should not write identity headers by default", async () => {
			const interceptor = createSessionAuthInterceptor({
				verifySession: (async () => MOCK_SESSION) as any,
				mapSession: MOCK_MAP_SESSION,
			});
			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest(MOCK_REQUEST_DEFAULTS);
			req.header.set("authorization", "Bearer token");

			await handler(req);

			assert.strictEqual(next.mock.calls.length, 1);
			for (const name of ["x-auth-subject", "x-auth-type", "x-auth-name", "x-auth-roles", "x-auth-scopes", "x-auth-claims"]) {
				assert.strictEqual(req.header.get(name), null, `${name} must stay absent unless propagateHeaders is enabled`);
			}
		});
	});
});
