/**
 * Unit tests for session-based authentication interceptor
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAuthContext } from "../../src/context.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
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
			const req = createMockRequest();
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
			const req = createMockRequest();
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
			const req = createMockRequest();

			await assert.rejects(
				() => handler(req),
				(err: unknown) => {
					assert.ok(err instanceof ConnectError);
					assert.strictEqual(err.code, Code.Unauthenticated);
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
			const req = createMockRequest();
			req.header.set("authorization", "Bearer bad-token");

			await assert.rejects(
				() => handler(req),
				(err: unknown) => {
					assert.ok(err instanceof ConnectError);
					assert.strictEqual(err.code, Code.Unauthenticated);
					assert.ok(err.message.includes("Session verification failed"));
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
			const req = createMockRequest();
			req.header.set("authorization", "Bearer token");

			await assert.rejects(
				() => handler(req),
				(err: unknown) => {
					assert.ok(err instanceof ConnectError);
					assert.strictEqual(err.code, Code.PermissionDenied);
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

			const next = createMockNext();
			const handler = interceptor(next);
			const req = createMockRequest();

			await handler(req);

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
			const req = createMockRequest();
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
			const req = createMockRequest();
			req.header.set("authorization", "Bearer token");

			await handler(req);

			assert.strictEqual(req.header.get(AUTH_HEADERS.SUBJECT), "user-42");
			assert.strictEqual(req.header.get(AUTH_HEADERS.TYPE), "session");
		});
	});
});
