/**
 * createOtelInterceptor() unit tests
 *
 * Tests ConnectRPC OpenTelemetry interceptor:
 * - Transparent pass-through of requests/responses
 * - Filter mechanism (skip/allow instrumentation)
 * - Feature toggles (withoutTracing, withoutMetrics)
 * - Error handling (ConnectError, generic Error)
 * - Context propagation (trustRemote)
 * - Streaming support
 * - Attribute filtering
 * - Server address/port options
 * - Message recording
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock ConnectRPC request object.
 *
 * Mirrors the shape of UnaryRequest / StreamRequest used by ConnectRPC
 * interceptors: service.typeName, method.name, stream flag, message, header.
 */
function createMockRequest(overrides?: Partial<{
	serviceName: string;
	methodName: string;
	stream: boolean;
	message: unknown;
	headers: Record<string, string>;
}>): any {
	const {
		serviceName = "test.TestService",
		methodName = "TestMethod",
		stream = false,
		message = { toBinary: () => new Uint8Array(42) },
		headers = {},
	} = overrides ?? {};

	const headerObj = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		headerObj.set(key, value);
	}

	return {
		service: { typeName: serviceName },
		method: { name: methodName },
		stream,
		message,
		header: headerObj,
	};
}

/**
 * Creates a mock next() function that returns a successful response.
 */
function createMockNext(response?: unknown): any {
	const defaultResponse = {
		stream: false,
		message: { toBinary: () => new Uint8Array(24) },
	};
	return async (_req: unknown) => response ?? defaultResponse;
}

/**
 * Creates a mock next() function that throws the given error.
 */
function createMockNextError(error: Error): any {
	return async (_req: unknown) => { throw error; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOtelInterceptor", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	// -----------------------------------------------------------------------
	// Basic functionality
	// -----------------------------------------------------------------------

	describe("basic functionality", () => {
		it("should return a function (Interceptor)", () => {
			const interceptor = createOtelInterceptor();

			assert.strictEqual(typeof interceptor, "function");
		});

		it("should return a handler function when called with next", () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNext());

			assert.strictEqual(typeof handler, "function");
		});

		it("should pass through requests transparently", async () => {
			const interceptor = createOtelInterceptor();
			const next = createMockNext();
			const req = createMockRequest();

			const handler = interceptor(next);
			const response = await handler(req);

			assert.ok(response);
		});

		it("should return response from next()", async () => {
			const expectedResponse = { stream: false, message: { value: 42 } };
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNext(expectedResponse));

			const response = await handler(createMockRequest());

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors from next()", async () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNextError(new Error("test error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "test error" },
			);
		});

		it("should call next() with the original request", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest();

			let receivedReq: unknown;
			const next = createMockNext();
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
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const next = createMockNext();
			const handler = interceptor(next);

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should instrument when filter returns true", async () => {
			const interceptor = createOtelInterceptor({
				filter: () => true,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should pass service, method, stream to filter", async () => {
			let filterArgs: unknown;
			const interceptor = createOtelInterceptor({
				filter: (ctx) => {
					filterArgs = ctx;
					return true;
				},
			});
			const handler = interceptor(createMockNext());

			await handler(createMockRequest({
				serviceName: "my.Service",
				methodName: "MyMethod",
				stream: true,
			}));

			assert.deepStrictEqual(filterArgs, {
				service: "my.Service",
				method: "MyMethod",
				stream: true,
			});
		});

		it("should still return response when filter skips instrumentation", async () => {
			const expectedResponse = { stream: false, message: { data: "ok" } };
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const handler = interceptor(createMockNext(expectedResponse));

			const response = await handler(createMockRequest());

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors even when filter returns false", async () => {
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const handler = interceptor(createMockNextError(new Error("filtered error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "filtered error" },
			);
		});
	});

	// -----------------------------------------------------------------------
	// Feature toggles
	// -----------------------------------------------------------------------

	describe("feature toggles", () => {
		it("should work with withoutTracing=true (metrics only)", async () => {
			const interceptor = createOtelInterceptor({ withoutTracing: true });
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should work with withoutMetrics=true (tracing only)", async () => {
			const interceptor = createOtelInterceptor({ withoutMetrics: true });
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should pass through when both tracing and metrics disabled", async () => {
			const expectedResponse = { stream: false, message: { bypass: true } };
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
			});
			const handler = interceptor(createMockNext(expectedResponse));

			const response = await handler(createMockRequest());

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors with withoutTracing=true", async () => {
			const interceptor = createOtelInterceptor({ withoutTracing: true });
			const handler = interceptor(createMockNextError(new Error("metrics-only error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "metrics-only error" },
			);
		});

		it("should propagate errors with withoutMetrics=true", async () => {
			const interceptor = createOtelInterceptor({ withoutMetrics: true });
			const handler = interceptor(createMockNextError(new Error("tracing-only error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "tracing-only error" },
			);
		});

		it("should propagate errors when both disabled", async () => {
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
			});
			const handler = interceptor(createMockNextError(new Error("no-op error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "no-op error" },
			);
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe("error handling", () => {
		it("should handle ConnectError and preserve code", async () => {
			const error = new ConnectError("not found", Code.NotFound);
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNextError(error));

			await assert.rejects(
				() => handler(createMockRequest()),
				(err: unknown) => {
					assert.ok(err instanceof ConnectError);
					assert.strictEqual(err.code, Code.NotFound);
					assert.strictEqual(err.message, "[not_found] not found");
					return true;
				},
			);
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
				const interceptor = createOtelInterceptor();
				const handler = interceptor(createMockNextError(error));

				await assert.rejects(
					() => handler(createMockRequest()),
					(err: unknown) => {
						assert.ok(err instanceof ConnectError);
						assert.strictEqual(err.code, code);
						return true;
					},
				);

				await shutdownProvider();
			}
		});

		it("should handle generic Error", async () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNextError(new TypeError("type error")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "type error" },
			);
		});

		it("should handle RangeError", async () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNextError(new RangeError("out of range")));

			await assert.rejects(
				() => handler(createMockRequest()),
				{ message: "out of range" },
			);
		});

		it("should handle ConnectError in metrics-only mode", async () => {
			const error = new ConnectError("unavailable", Code.Unavailable);
			const interceptor = createOtelInterceptor({ withoutTracing: true });
			const handler = interceptor(createMockNextError(error));

			await assert.rejects(
				() => handler(createMockRequest()),
				(err: unknown) => {
					assert.ok(err instanceof ConnectError);
					assert.strictEqual(err.code, Code.Unavailable);
					return true;
				},
			);
		});
	});

	// -----------------------------------------------------------------------
	// Context propagation
	// -----------------------------------------------------------------------

	describe("context propagation", () => {
		it("should work with trustRemote=true", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: true });
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should work with trustRemote=false (default)", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: false });
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should extract headers for context propagation", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: true });
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest({
				headers: {
					"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				},
			}));

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Streaming
	// -----------------------------------------------------------------------

	describe("streaming", () => {
		it("should handle streaming requests", async () => {
			const interceptor = createOtelInterceptor();
			const streamResponse = { stream: true, message: null };
			const handler = interceptor(createMockNext(streamResponse));

			const response = await handler(createMockRequest({ stream: true }));

			assert.ok(response);
		});

		it("should handle streaming with filter", async () => {
			let receivedStream: boolean | undefined;
			const interceptor = createOtelInterceptor({
				filter: (ctx) => {
					receivedStream = ctx.stream;
					return true;
				},
			});
			const handler = interceptor(createMockNext({ stream: true, message: null }));

			await handler(createMockRequest({ stream: true }));

			assert.strictEqual(receivedStream, true);
		});

		it("should handle unary requests (stream=false)", async () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest({ stream: false }));

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Options: attributeFilter
	// -----------------------------------------------------------------------

	describe("attributeFilter", () => {
		it("should work with attributeFilter that allows all", async () => {
			const interceptor = createOtelInterceptor({
				attributeFilter: () => true,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should work with attributeFilter that blocks all", async () => {
			const interceptor = createOtelInterceptor({
				attributeFilter: () => false,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should pass key and value to attributeFilter", async () => {
			const filteredKeys: string[] = [];
			const interceptor = createOtelInterceptor({
				attributeFilter: (key, _value) => {
					filteredKeys.push(key);
					return true;
				},
			});
			const handler = interceptor(createMockNext());

			await handler(createMockRequest());

			// Should have received attribute keys from base attributes
			assert.ok(filteredKeys.length > 0);
			assert.ok(filteredKeys.includes("rpc.system"));
			assert.ok(filteredKeys.includes("rpc.service"));
			assert.ok(filteredKeys.includes("rpc.method"));
			assert.ok(filteredKeys.includes("server.address"));
		});

		it("should selectively filter attributes", async () => {
			// Only allow rpc.* attributes, block server.* and network.*
			const interceptor = createOtelInterceptor({
				attributeFilter: (key) => key.startsWith("rpc."),
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Options: serverAddress / serverPort
	// -----------------------------------------------------------------------

	describe("serverAddress and serverPort", () => {
		it("should accept custom serverAddress", async () => {
			const interceptor = createOtelInterceptor({
				serverAddress: "my-host.example.com",
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should accept serverPort", async () => {
			const interceptor = createOtelInterceptor({
				serverPort: 5000,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should include serverPort in attributeFilter calls", async () => {
			const filteredKeys: string[] = [];
			const interceptor = createOtelInterceptor({
				serverPort: 8080,
				attributeFilter: (key, _value) => {
					filteredKeys.push(key);
					return true;
				},
			});
			const handler = interceptor(createMockNext());

			await handler(createMockRequest());

			assert.ok(filteredKeys.includes("server.port"));
		});

		it("should not include server.port when serverPort is undefined", async () => {
			const filteredKeys: string[] = [];
			const interceptor = createOtelInterceptor({
				attributeFilter: (key, _value) => {
					filteredKeys.push(key);
					return true;
				},
			});
			const handler = interceptor(createMockNext());

			await handler(createMockRequest());

			assert.ok(!filteredKeys.includes("server.port"));
		});
	});

	// -----------------------------------------------------------------------
	// Options: recordMessages
	// -----------------------------------------------------------------------

	describe("recordMessages", () => {
		it("should work with recordMessages=true for unary", async () => {
			const interceptor = createOtelInterceptor({
				recordMessages: true,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest({ stream: false }));

			assert.ok(response);
		});

		it("should work with recordMessages=true for streaming", async () => {
			const interceptor = createOtelInterceptor({
				recordMessages: true,
			});
			const handler = interceptor(createMockNext({ stream: true, message: null }));

			const response = await handler(createMockRequest({ stream: true }));

			assert.ok(response);
		});

		it("should work with recordMessages=false (default)", async () => {
			const interceptor = createOtelInterceptor({
				recordMessages: false,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Message size estimation
	// -----------------------------------------------------------------------

	describe("message size estimation", () => {
		it("should handle message with toBinary()", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { toBinary: () => new Uint8Array(100) },
			});
			const handler = interceptor(createMockNext());

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle message without toBinary()", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { someField: "value" },
			});
			const handler = interceptor(createMockNext());

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle null message", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({ message: null });
			const handler = interceptor(createMockNext());

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle empty binary message", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { toBinary: () => new Uint8Array(0) },
			});
			const handler = interceptor(createMockNext());

			const response = await handler(req);

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Default options
	// -----------------------------------------------------------------------

	describe("default options", () => {
		it("should work with no options", async () => {
			const interceptor = createOtelInterceptor();
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should work with empty options object", async () => {
			const interceptor = createOtelInterceptor({});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});
	});

	// -----------------------------------------------------------------------
	// Combined options
	// -----------------------------------------------------------------------

	describe("combined options", () => {
		it("should handle all options together", async () => {
			const interceptor = createOtelInterceptor({
				withoutTracing: false,
				withoutMetrics: false,
				trustRemote: true,
				filter: () => true,
				attributeFilter: () => true,
				serverAddress: "test-host",
				serverPort: 3000,
				recordMessages: true,
			});
			const handler = interceptor(createMockNext());

			const response = await handler(createMockRequest());

			assert.ok(response);
		});

		it("should respect filter even with other options set", async () => {
			const expectedResponse = { stream: false, message: { filtered: true } };
			const interceptor = createOtelInterceptor({
				withoutTracing: false,
				withoutMetrics: false,
				trustRemote: true,
				filter: () => false,
				serverPort: 3000,
				recordMessages: true,
			});
			const handler = interceptor(createMockNext(expectedResponse));

			const response = await handler(createMockRequest());

			// When filter returns false, should still return the response
			assert.strictEqual(response, expectedResponse);
		});

		it("should apply filter before no-op check", async () => {
			// filter: false skips before checking withoutTracing/withoutMetrics
			let nextCalled = false;
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
				filter: () => false,
			});
			const next: any = async (_req: unknown) => {
				nextCalled = true;
				return { stream: false, message: {} };
			};
			const handler = interceptor(next);

			await handler(createMockRequest());

			assert.ok(nextCalled, "next() should still be called when filter skips");
		});
	});
});
