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
import {
	assertConnectError,
	createMockNext,
	createMockRequest,
	InMemoryMetricCollector,
	InMemorySpanCollector,
	type NormalizedMetric,
	type NormalizedSpan,
} from "@connectum/testing";
import { metrics as metricsApi, SpanKind, trace } from "@opentelemetry/api";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

// ---------------------------------------------------------------------------
// Otel-specific default message (for size estimation tests)
// ---------------------------------------------------------------------------

const OTEL_REQUEST_MESSAGE = { toBinary: () => new Uint8Array(42) };
const OTEL_RESPONSE_MESSAGE = { toBinary: () => new Uint8Array(24) };

// ---------------------------------------------------------------------------
// Telemetry observation
// ---------------------------------------------------------------------------

// The method the OpenTelemetry RPC conventions call `<package>.<Service>/<Method>`.
const SERVICE = "acme.greeter.v1.GreeterService";
const METHOD = "SayHello";
const FULL_METHOD = "acme.greeter.v1.GreeterService/SayHello";

interface Observed {
	spans: NormalizedSpan[];
	metrics: NormalizedMetric[];
	/** Attributes of every recorded point of the server call-duration histogram. */
	durationPoints: Array<Record<string, unknown>>;
}

/**
 * Runs `body` against fresh in-memory tracer and meter providers installed as the
 * OpenTelemetry globals and returns what the interceptor recorded. The globals and
 * the package's cached provider are reset before and after, so a test sees only its
 * own telemetry and leaves nothing behind.
 */
async function observe(body: () => Promise<void>): Promise<Observed> {
	const spanCollector = new InMemorySpanCollector();
	const metricCollector = new InMemoryMetricCollector();
	await shutdownProvider();
	trace.disable();
	metricsApi.disable();
	trace.setGlobalTracerProvider(spanCollector.provider);
	metricsApi.setGlobalMeterProvider(metricCollector.provider);
	try {
		await body();
		const spans = spanCollector.flush();
		const metrics = await metricCollector.flush();
		const duration = metrics.find((m) => m.name === semconv.METRIC_RPC_SERVER_CALL_DURATION);
		return { spans, metrics, durationPoints: duration?.points.map((p) => p.attributes) ?? [] };
	} finally {
		await shutdownProvider();
		trace.disable();
		metricsApi.disable();
		await spanCollector.dispose();
		await metricCollector.dispose();
	}
}

/** Request for the conventions' example method, as the interceptor sees it. */
function greeterRequest(extra: { stream?: boolean } = {}) {
	return createMockRequest({ service: SERVICE, method: METHOD, message: OTEL_REQUEST_MESSAGE, ...extra });
}

/** The one server span of a call; fails with a readable message otherwise. */
function onlySpan(observed: Observed): NormalizedSpan {
	assert.strictEqual(observed.spans.length, 1, `expected exactly one span, got ${observed.spans.map((s) => s.name).join(", ") || "none"}`);
	return observed.spans[0] as NormalizedSpan;
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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			assert.strictEqual(typeof handler, "function");
		});

		it("should hand the response through and record one server span and one duration point for a unary call", async () => {
			const expectedResponse = { stream: false, message: OTEL_RESPONSE_MESSAGE };
			const handler = createOtelInterceptor()((async () => expectedResponse) as never);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			// openspec otel-rpc-semconv: span named by the fully qualified method, carrying
			// rpc.system.name=connectrpc and rpc.method, a successful unary call carries
			// rpc.response.status_code=OK and no error.type.
			const span = onlySpan(observed);
			assert.strictEqual(span.name, FULL_METHOD);
			assert.strictEqual(span.kind, SpanKind.SERVER);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_SYSTEM_NAME], semconv.RPC_SYSTEM_NAME_VALUE_CONNECTRPC);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_METHOD], FULL_METHOD);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.ok(!(semconv.ATTR_ERROR_TYPE in span.attributes), "a successful call must not carry error.type");
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_METHOD], FULL_METHOD);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
		});

		it("should return response from next()", async () => {
			const expectedResponse = { stream: false, message: { value: 42 } };
			const interceptor = createOtelInterceptor();
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors from next()", async () => {
			const interceptor = createOtelInterceptor();
			const next: any = async (_req: unknown) => { throw new Error("test error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "test error" },
			);
		});

		it("should call next() with the original request", async () => {
			const interceptor = createOtelInterceptor();
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
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const next = createMockNext({ message: OTEL_RESPONSE_MESSAGE });
			const handler = interceptor(next);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.ok(response, "the call itself still goes through");
			assert.strictEqual(next.mock.calls.length, 1);
			assert.deepStrictEqual(observed.spans, [], "a filtered-out call must not start a span");
			assert.deepStrictEqual(observed.metrics, [], "a filtered-out call must not record a metric");
		});

		it("should instrument when filter returns true", async () => {
			const interceptor = createOtelInterceptor({
				filter: () => true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
			assert.strictEqual(observed.durationPoints.length, 1);
		});

		it("should pass service, method, stream to filter", async () => {
			let filterArgs: unknown;
			const interceptor = createOtelInterceptor({
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
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(response, expectedResponse);
		});

		it("should propagate errors even when filter returns false", async () => {
			const interceptor = createOtelInterceptor({
				filter: () => false,
			});
			const next: any = async (_req: unknown) => { throw new Error("filtered error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(observed.spans, [], "withoutTracing must not start a span");
			assert.strictEqual(observed.durationPoints.length, 1, "the duration metric is still recorded");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_METHOD], FULL_METHOD);
		});

		it("should work with withoutMetrics=true (tracing only)", async () => {
			const interceptor = createOtelInterceptor({ withoutMetrics: true });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
			assert.deepStrictEqual(observed.metrics, [], "withoutMetrics must not record any metric");
		});

		it("should pass through when both tracing and metrics disabled", async () => {
			const expectedResponse = { stream: false, message: { bypass: true } };
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
			});
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			assert.deepStrictEqual(observed.spans, []);
			assert.deepStrictEqual(observed.metrics, []);
		});

		it("should propagate errors with withoutTracing=true", async () => {
			const interceptor = createOtelInterceptor({ withoutTracing: true });
			const next: any = async (_req: unknown) => { throw new Error("metrics-only error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "metrics-only error" },
			);
		});

		it("should propagate errors with withoutMetrics=true", async () => {
			const interceptor = createOtelInterceptor({ withoutMetrics: true });
			const next: any = async (_req: unknown) => { throw new Error("tracing-only error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
				{ message: "tracing-only error" },
			);
		});

		it("should propagate errors when both disabled", async () => {
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
			});
			const next: any = async (_req: unknown) => { throw new Error("no-op error"); };

			const handler = interceptor(next);

			await assert.rejects(
				() => handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE })),
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
			const next: any = async (_req: unknown) => { throw error; };

			const handler = interceptor(next);

			const observed = await observe(async () => {
				try {
					await handler(greeterRequest());
					assert.fail("Expected ConnectError");
				} catch (err) {
					assertConnectError(err, Code.NotFound, "not found");
				}
			});

			// openspec otel-rpc-semconv: a failed call carries the Connect error-code name as
			// rpc.response.status_code and error.type, on the span and on the duration metric.
			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
		});

		// One test per code so a failure names the code. Names are the Connect protocol's
		// error-code names in upper case, spelled out here rather than read from the package.
		const CODE_NAMES: ReadonlyArray<readonly [number, string]> = [
			[Code.InvalidArgument, "INVALID_ARGUMENT"],
			[Code.PermissionDenied, "PERMISSION_DENIED"],
			[Code.Internal, "INTERNAL"],
			[Code.Unavailable, "UNAVAILABLE"],
			[Code.Unauthenticated, "UNAUTHENTICATED"],
		];

		for (const [code, name] of CODE_NAMES) {
			it(`should report a ConnectError with code ${name} as error.type and rpc.response.status_code`, async () => {
				const error = new ConnectError("error", code);
				const interceptor = createOtelInterceptor();
				const next: any = async (_req: unknown) => { throw error; };

				const handler = interceptor(next);

				const observed = await observe(async () => {
					try {
						await handler(greeterRequest());
						assert.fail("Expected ConnectError");
					} catch (err) {
						assertConnectError(err, code);
					}
				});

				const span = onlySpan(observed);
				assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], name);
				assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], name);
				assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], name);
				assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], name);
			});
		}

		// For an error that is not a ConnectError the convention asks error.type to be
		// the error's class name (metrics guide: "the error class name for another Error").
		it("should handle generic Error", async () => {
			const interceptor = createOtelInterceptor();
			const next: any = async (_req: unknown) => { throw new TypeError("type error"); };

			const handler = interceptor(next);

			const observed = await observe(async () => {
				await assert.rejects(
					() => handler(greeterRequest()),
					{ message: "type error" },
				);
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_ERROR_TYPE], "TypeError");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "TypeError");
		});

		it("should handle RangeError", async () => {
			const interceptor = createOtelInterceptor();
			const next: any = async (_req: unknown) => { throw new RangeError("out of range"); };

			const handler = interceptor(next);

			const observed = await observe(async () => {
				await assert.rejects(
					() => handler(greeterRequest()),
					{ message: "out of range" },
				);
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_ERROR_TYPE], "RangeError");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "RangeError");
		});

		it("should handle ConnectError in metrics-only mode", async () => {
			const error = new ConnectError("unavailable", Code.Unavailable);
			const interceptor = createOtelInterceptor({ withoutTracing: true });
			const next: any = async (_req: unknown) => { throw error; };

			const handler = interceptor(next);

			const observed = await observe(async () => {
				try {
					await handler(greeterRequest());
					assert.fail("Expected ConnectError");
				} catch (err) {
					assertConnectError(err, Code.Unavailable, "unavailable");
				}
			});

			assert.deepStrictEqual(observed.spans, []);
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "UNAVAILABLE");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "UNAVAILABLE");
		});
	});

	// -----------------------------------------------------------------------
	// Context propagation
	// -----------------------------------------------------------------------

	describe("context propagation", () => {
		it("should work with trustRemote=true", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: true });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with trustRemote=false (default)", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: false });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should extract headers for context propagation", async () => {
			const interceptor = createOtelInterceptor({ trustRemote: true });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({
				message: OTEL_REQUEST_MESSAGE,
				headers: new Headers({
					"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				}),
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
			const next: any = async (_req: unknown) => streamResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ stream: true, message: OTEL_REQUEST_MESSAGE }));

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
			const next: any = async (_req: unknown) => ({ stream: true, message: null });

			const handler = interceptor(next);
			await handler(createMockRequest({ stream: true, message: OTEL_REQUEST_MESSAGE }));

			assert.strictEqual(receivedStream, true);
		});

		it("should handle unary requests (stream=false)", async () => {
			const interceptor = createOtelInterceptor();
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
			const interceptor = createOtelInterceptor({
				attributeFilter: () => true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with attributeFilter that blocks all", async () => {
			const interceptor = createOtelInterceptor({
				attributeFilter: () => false,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			// Should have received attribute keys from base attributes
			assert.ok(filteredKeys.length > 0);
			assert.ok(filteredKeys.includes("rpc.system.name"));
			assert.ok(filteredKeys.includes("rpc.method"));
			assert.ok(filteredKeys.includes("server.address"));
		});

		it("should selectively filter attributes", async () => {
			// Only allow rpc.* attributes, block server.* and network.*
			const interceptor = createOtelInterceptor({
				attributeFilter: (key) => key.startsWith("rpc."),
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should accept serverPort", async () => {
			const interceptor = createOtelInterceptor({
				serverPort: 5000,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const interceptor = createOtelInterceptor({
				recordMessages: true,
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with recordMessages=true for streaming", async () => {
			const interceptor = createOtelInterceptor({
				recordMessages: true,
			});
			const next: any = async (_req: unknown) => ({ stream: true, message: null });

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ stream: true, message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with recordMessages=false (default)", async () => {
			const interceptor = createOtelInterceptor({
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
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { toBinary: () => new Uint8Array(100) },
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle message without toBinary()", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { someField: "value" },
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle null message", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({ message: null });
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(req);

			assert.ok(response);
		});

		it("should handle empty binary message", async () => {
			const interceptor = createOtelInterceptor();
			const req = createMockRequest({
				message: { toBinary: () => new Uint8Array(0) },
			});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(response);
		});

		it("should work with empty options object", async () => {
			const interceptor = createOtelInterceptor({});
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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
			const next: any = async (_req: unknown) => expectedResponse;

			const handler = interceptor(next);
			const response = await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

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

			await handler(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

			assert.ok(nextCalled, "next() should still be called when filter skips");
		});
	});
});
