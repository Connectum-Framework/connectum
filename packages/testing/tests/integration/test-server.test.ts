/**
 * Integration tests for createTestServer and withTestServer.
 *
 * These tests start real gRPC servers to verify lifecycle management.
 * Empty service arrays are used since we only need to verify
 * server startup, port assignment, and shutdown — not actual RPC handling.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createTestServer, withTestServer } from "../../src/test-server.ts";

describe("createTestServer", () => {
	it("should start on a random port", async () => {
		const server = await createTestServer({ services: [] });
		try {
			assert.ok(server.port > 0, `Expected port > 0, got ${server.port}`);
			assert.ok(
				server.baseUrl.includes(String(server.port)),
				`Expected baseUrl to contain port ${server.port}, got ${server.baseUrl}`,
			);
			assert.ok(server.transport, "Expected transport to be defined");
		} finally {
			await server.close();
		}
	});

	it("should stop cleanly when close() is called", async () => {
		const server = await createTestServer({ services: [] });
		await server.close();

		// Verify close resolves without error — server is stopped.
		// Starting another server on port 0 confirms the runtime is healthy.
		const server2 = await createTestServer({ services: [] });
		try {
			assert.ok(server2.port > 0, "Second server should start successfully");
		} finally {
			await server2.close();
		}
	});

	it("should support multiple servers running in parallel", async () => {
		const [server1, server2] = await Promise.all([
			createTestServer({ services: [] }),
			createTestServer({ services: [] }),
		]);

		try {
			assert.ok(server1.port > 0, `Server 1 port should be > 0, got ${server1.port}`);
			assert.ok(server2.port > 0, `Server 2 port should be > 0, got ${server2.port}`);
			assert.notStrictEqual(
				server1.port,
				server2.port,
				`Servers should have different ports: ${server1.port} vs ${server2.port}`,
			);
		} finally {
			await Promise.all([server1.close(), server2.close()]);
		}
	});
});

describe("withTestServer", () => {
	it("should provide server and auto-close after testFn completes", async () => {
		let capturedPort = 0;

		await withTestServer({ services: [] }, async (server) => {
			assert.ok(server.port > 0, `Expected port > 0, got ${server.port}`);
			assert.ok(server.baseUrl, "Expected baseUrl to be defined");
			assert.ok(server.transport, "Expected transport to be defined");
			capturedPort = server.port;
		});

		// After withTestServer returns, the server should be closed.
		// Verify by starting a new server (runtime is healthy after cleanup).
		assert.ok(capturedPort > 0, "Test function should have run");
		const verification = await createTestServer({ services: [] });
		await verification.close();
	});

	it("should close server and re-throw when testFn throws", async () => {
		const testError = new Error("intentional test failure");

		await assert.rejects(
			() =>
				withTestServer({ services: [] }, async () => {
					throw testError;
				}),
			(err: Error) => {
				assert.strictEqual(err, testError, "Should re-throw the original error");
				return true;
			},
		);

		// Server should be cleaned up despite the error.
		// Verify runtime health by starting another server.
		const verification = await createTestServer({ services: [] });
		await verification.close();
	});

	it("should return the value from testFn", async () => {
		const result = await withTestServer({ services: [] }, async (server) => {
			return { port: server.port, ok: true };
		});

		assert.ok(result.ok, "Expected result.ok to be true");
		assert.ok(result.port > 0, `Expected result.port > 0, got ${result.port}`);
	});
});
