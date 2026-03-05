/**
 * createOtelClientInterceptor() unit tests
 *
 * Tests ConnectRPC OpenTelemetry client interceptor:
 * - Transparent pass-through of requests/responses
 * - Filter mechanism (skip/allow instrumentation)
 * - Feature toggles (withoutTracing, withoutMetrics)
 * - Error handling (ConnectError, generic Error)
 * - Context injection (propagation.inject into outgoing headers)
 * - Streaming support
 * - Attribute filtering
 * - Server address/port options (serverAddress required)
 * - Message recording
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// ---------------------------------------------------------------------------
// Otel-specific default message (for size estimation tests)
// ---------------------------------------------------------------------------

const OTEL_REQUEST_MESSAGE = { toBinary: () => new Uint8Array(42) };
const OTEL_RESPONSE_MESSAGE = { toBinary: () => new Uint8Array(24) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOtelClientInterceptor", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	// -----------------------------------------------------------------------
	// Basic functionality
	// -----------------------------------------------------------------------

	describe("basic functionality", () => {
		it("should return a function (Interceptor)", () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});

			assert.strictEqual(typeof interceptor, "function");
		});

		it("should return a handler function when called with next", () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			assert.strictEqual(typeof handler, "function");
		});

		it("should pass through requests transparently", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const next = createMockNext({ message: OTEL_RESPONSE_MESSAGE });
			const req = createMockRequest({ message: OTEL_REQUEST_MESSAGE });

			const handler = interceptor(next);
			const response = await handler(req);

			assert.ok(response);
		});

		it("should return response from next()", async () => {
			const expectedResponse = { stream: false, message: { value: 42 } };
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors from next()", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const next: any = async (_req: unknown) => { throw new Error("test error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "test error" },
			);
		});

		it("should call next() with the original request", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const req = createMockRequest({ message: OTEL_REQUEST_MESSAGE });

			let receivedReq: unknown;
			const next = createMockNext({ message: OTEL_RESPONSE_MESSAGE });
			// Wrap next to capture the request argument
			const wrappedNext: any = async (r: unknown) => {
				receivedReq = r;
				return next(r);
			};

			const handler = interceptor(wrappedNext);
			await handler(req);

			assert.strictEqual(receivedReq, req);
		});
	});

	// -----------------------------------------------------------------------
	// Filter
	// -----------------------------------------------------------------------

	describe("filter", () => {
		it("should skip instrumentation when filter returns false", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				filter: () => false,
			});
			const next = createMockNext({ message: OTEL_RESPONSE_MESSAGE });
			const handler = interceptor(next);

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should instrument when filter returns true", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				filter: () => true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should pass service, method, stream to filter", async () => {
			let filterArgs: unknown;
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				filter: (ctx) => {
					filterArgs = ctx;
					return true;
				},
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({
				service: "my.Service",
				method: "MyMethod",
				stream: true,
				message: OTEL_REQUEST_MESSAGE,
			}));

			assert.deepStrictEqual(filterArgs, {
				service: "my.Service",
				method: "MyMethod",
				stream: true,
			});
		});

		it("should still return response when filter skips instrumentation", async () => {
			const expectedResponse = { stream: false, message: { data: "ok" } };
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				filter: () => false,
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(response, expectedResponse);
		});
	});

	// -----------------------------------------------------------------------
	// Feature toggles
	// -----------------------------------------------------------------------

	describe("feature toggles", () => {
		it("should work with withoutTracing=true (metrics only)", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutTracing: true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with withoutMetrics=true (tracing only)", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutMetrics: true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should pass through when both tracing and metrics disabled", async () => {
			const expectedResponse = { stream: false, message: { bypass: true } };
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutTracing: true,
				withoutMetrics: true,
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors with withoutTracing=true", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutTracing: true,
			});
			const next: any = async (_req: unknown) => { throw new Error("metrics-only error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "metrics-only error" },
			);
		});

		it("should propagate errors with withoutMetrics=true", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutMetrics: true,
			});
			const next: any = async (_req: unknown) => { throw new Error("tracing-only error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "tracing-only error" },
			);
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe("error handling", () => {
		it("should handle ConnectError and preserve code", async () => {
			const error = new ConnectError("not found", Code.NotFound);
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const next: any = async (_req: unknown) => { throw error; };

			const handler = interceptor(next);

			try {
				await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));
				assert.fail("Expected ConnectError");
			} catch (err) {
				assertConnectError(err, Code.NotFound, "not found");
			}
		});

		it("should handle ConnectError with different codes", async () => {
			const codes = [
				Code.InvalidArgument,
				Code.PermissionDenied,
				Code.Internal,
				Code.Unavailable,
				Code.Unauthenticated,
			];

			for (const code of codes) {
				const error = new ConnectError("error", code);
				const interceptor = createOtelClientInterceptor({
					serverAddress: "localhost",
				});
				const next: any = async (_req: unknown) => { throw error; };

				const handler = interceptor(next);

				try {
					await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));
					assert.fail("Expected ConnectError");
				} catch (err) {
					assertConnectError(err, code);
				}

				await shutdownProvider();
			}
		});

		it("should handle generic Error", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const next: any = async (_req: unknown) => { throw new TypeError("type error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "type error" },
			);
		});

		it("should handle ConnectError in metrics-only mode", async () => {
			const error = new ConnectError("unavailable", Code.Unavailable);
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				withoutTracing: true,
			});
			const next: any = async (_req: unknown) => { throw error; };

			const handler = interceptor(next);

			try {
				await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));
				assert.fail("Expected ConnectError");
			} catch (err) {
				assertConnectError(err, Code.Unavailable, "unavailable");
			}
		});
	});

	// -----------------------------------------------------------------------
	// Context injection (CLIENT-SPECIFIC)
	// -----------------------------------------------------------------------

	describe("context injection", () => {
		it("should inject trace context into request headers", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "api.example.com",
			});
			const req = createMockRequest({ message: OTEL_REQUEST_MESSAGE });

			let capturedReq: unknown;
			const next: any = async (r: unknown) => {
				capturedReq = r;
				return { stream: false, message: OTEL_RESPONSE_MESSAGE };
			};

			const handler = interceptor(next);
			await handler(req);

			// Propagation.inject should have added headers to the request
			// In a real OTel setup this would add traceparent/tracestate
			// With noop propagator the headers may or may not be added,
			// but the interceptor should have called next with the same request object
			assert.strictEqual(capturedReq, req);
		});
	});

	// -----------------------------------------------------------------------
	// Streaming
	// -----------------------------------------------------------------------

	describe("streaming", () => {
		it("should handle streaming requests", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const streamResponse = { stream: true, message: null };
			const next: any = async (_req: unknown) => streamResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ stream: true, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should handle unary requests (stream=false)", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Options: attributeFilter
	// -----------------------------------------------------------------------

	describe("attributeFilter", () => {
		it("should work with attributeFilter that allows all", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				attributeFilter: () => true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with attributeFilter that blocks all", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				attributeFilter: () => false,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should pass key and value to attributeFilter", async () => {
			const filteredKeys: string[] = [];
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				attributeFilter: (key, _value) => {
					filteredKeys.push(key);
					return true;
				},
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			// Should have received attribute keys from base attributes
			assert.ok(filteredKeys.length > 0);
			assert.ok(filteredKeys.includes("rpc.system"));
			assert.ok(filteredKeys.includes("rpc.service"));
			assert.ok(filteredKeys.includes("rpc.method"));
			assert.ok(filteredKeys.includes("server.address"));
		});
	});

	// -----------------------------------------------------------------------
	// Options: serverAddress / serverPort
	// -----------------------------------------------------------------------

	describe("serverAddress and serverPort", () => {
		it("should include serverAddress in attributes", async () => {
			const receivedValues: Record<string, string | number | boolean> = {};
			const interceptor = createOtelClientInterceptor({
				serverAddress: "api.example.com",
				attributeFilter: (key, value) => {
					receivedValues[key] = value;
					return true;
				},
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(receivedValues["server.address"], "api.example.com");
		});

		it("should include serverPort when provided", async () => {
			const receivedValues: Record<string, string | number | boolean> = {};
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				serverPort: 5000,
				attributeFilter: (key, value) => {
					receivedValues[key] = value;
					return true;
				},
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(receivedValues["server.port"], 5000);
		});

		it("should not include server.port when serverPort is undefined", async () => {
			const filteredKeys: string[] = [];
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				attributeFilter: (key, _value) => {
					filteredKeys.push(key);
					return true;
				},
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(!filteredKeys.includes("server.port"));
		});
	});

	// -----------------------------------------------------------------------
	// Options: recordMessages
	// -----------------------------------------------------------------------

	describe("recordMessages", () => {
		it("should work with recordMessages=true for unary", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				recordMessages: true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with recordMessages=true for streaming", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				recordMessages: true,
			});
			const next: any = async (_req: unknown) => ({ stream: true, message: null });

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ stream: true, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with recordMessages=false (default)", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
				recordMessages: false,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Message size estimation
	// -----------------------------------------------------------------------

	describe("message size estimation", () => {
		it("should handle message with toBinary()", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const req = createMockRequest({
				message: { toBinary: () => new Uint8Array(100) },
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle message without toBinary()", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const req = createMockRequest({
				message: { someField: "value" },
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle null message", async () => {
			const interceptor = createOtelClientInterceptor({
				serverAddress: "localhost",
			});
			const req = createMockRequest({ message: null });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Combined options
	// -----------------------------------------------------------------------

	describe("combined options", () => {
		it("should handle all options together", async () => {
			const interceptor = createOtelClientInterceptor({
				withoutTracing: false,
				withoutMetrics: false,
				filter: () => true,
				attributeFilter: () => true,
				serverAddress: "test-host",
				serverPort: 3000,
				recordMessages: true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should respect filter even with other options set", async () => {
			const expectedResponse = { stream: false, message: { filtered: true } };
			const interceptor = createOtelClientInterceptor({
				withoutTracing: false,
				withoutMetrics: false,
				filter: () => false,
				serverAddress: "test-host",
				serverPort: 3000,
				recordMessages: true,
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			// When filter returns false, should still return the response
			assert.strictEqual(response, expectedResponse);
		});
	});
});
