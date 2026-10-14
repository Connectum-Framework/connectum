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
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";
import { histogramTotals, type Observed, observe as observeTelemetry, onlySpan, pointAttributes } from "./observe.ts";

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
const SERVER_ADDRESS = "api.example.com";

interface ClientObserved extends Observed {
	/** Attributes of every recorded point of the client call-duration histogram. */
	durationPoints: Array<Record<string, unknown>>;
}

async function observe(body: () => Promise<void>): Promise<ClientObserved> {
	const observed = await observeTelemetry(body);
	return { ...observed, durationPoints: pointAttributes(observed, semconv.METRIC_RPC_CLIENT_CALL_DURATION) };
}

/** Request for the conventions' example method, as the interceptor sees it. */
function greeterRequest(extra: { stream?: boolean; message?: unknown } = {}) {
	return createMockRequest({ service: SERVICE, method: METHOD, message: OTEL_REQUEST_MESSAGE, ...extra });
}

/** Interceptor options with the required server address filled in. */
function clientOptions(options: Partial<Parameters<typeof createOtelClientInterceptor>[0]> = {}) {
	return { serverAddress: SERVER_ADDRESS, ...options };
}

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

		// Oracle: the otel-rpc-semconv specification (span named by the fully qualified
		// method, rpc.system.name=connectrpc, rpc.method, a successful unary call carries
		// rpc.response.status_code=OK and no error.type) and the OpenTelemetry span kind
		// for the calling side.
		it("should hand the response through and record one client span and one duration point", async () => {
			const expectedResponse = { stream: false, message: OTEL_RESPONSE_MESSAGE };
			const handler = createOtelClientInterceptor(clientOptions())((async () => expectedResponse) as never);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			const span = onlySpan(observed);
			assert.strictEqual(span.name, FULL_METHOD);
			assert.strictEqual(span.kind, SpanKind.CLIENT);
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
			const interceptor = createOtelClientInterceptor(clientOptions({ filter: () => false }));
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
			const interceptor = createOtelClientInterceptor(clientOptions({ filter: () => true }));
			const handler = interceptor(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
			assert.strictEqual(observed.durationPoints.length, 1);
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
		it("should record only the duration metric with withoutTracing=true", async () => {
			const handler = createOtelClientInterceptor(clientOptions({ withoutTracing: true }))(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(observed.spans, [], "withoutTracing must not start a span");
			assert.strictEqual(observed.durationPoints.length, 1, "the duration metric is still recorded");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_METHOD], FULL_METHOD);
		});

		it("should record only the span with withoutMetrics=true", async () => {
			const handler = createOtelClientInterceptor(clientOptions({ withoutMetrics: true }))(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
			assert.deepStrictEqual(observed.metrics, [], "withoutMetrics must not record any metric");
		});

		it("should pass through without a span or a metric when both tracing and metrics are disabled", async () => {
			const expectedResponse = { stream: false, message: { bypass: true } };
			const interceptor = createOtelClientInterceptor(clientOptions({ withoutTracing: true, withoutMetrics: true }));
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
		// Oracle: the otel-rpc-semconv specification (a failed call carries the Connect
		// error-code name as rpc.response.status_code and error.type on its span and its
		// duration metric) and the OpenTelemetry guide on recording errors (the span
		// status code SHOULD be Error and the description the exception message).
		it("should handle ConnectError and preserve code", async () => {
			const error = new ConnectError("not found", Code.NotFound);
			const interceptor = createOtelClientInterceptor(clientOptions());
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

			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
			assert.strictEqual(span.status.message, error.message);
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
				const interceptor = createOtelClientInterceptor(clientOptions());
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
		it("should report the class name of a generic Error as error.type and mark the span failed", async () => {
			const interceptor = createOtelClientInterceptor(clientOptions());
			const next: any = async (_req: unknown) => { throw new TypeError("type error"); };

			const handler = interceptor(next);

			const observed = await observe(async () => {
				await assert.rejects(
					() => handler(greeterRequest()),
					{ message: "type error" },
				);
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "TypeError");
			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
			assert.strictEqual(span.status.message, "type error");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "TypeError");
		});

		it("should handle ConnectError in metrics-only mode", async () => {
			const error = new ConnectError("unavailable", Code.Unavailable);
			const interceptor = createOtelClientInterceptor(clientOptions({ withoutTracing: true }));
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
	// Context injection (CLIENT-SPECIFIC)
	// -----------------------------------------------------------------------

	describe("context injection", () => {
		// Oracle: W3C Trace Context, section "traceparent Header Field Values":
		// version-trace-id-parent-id-trace-flags as 2, 32, 16 and 2 lowercase hex
		// digits. The header the next hop receives must carry the trace id and the
		// span id of the client span this interceptor created, with the sampled flag.
		it("should send a W3C traceparent header that identifies the exported client span", async () => {
			const contextManager = new AsyncLocalStorageContextManager();
			contextManager.enable();
			const exporter = new InMemorySpanExporter();
			const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
			await shutdownProvider();
			trace.disable();
			context.disable();
			propagation.disable();
			trace.setGlobalTracerProvider(tracerProvider);
			context.setGlobalContextManager(contextManager);
			propagation.setGlobalPropagator(new W3CTraceContextPropagator());

			try {
				const interceptor = createOtelClientInterceptor({ serverAddress: "api.example.com" });
				let sentTraceparent: string | null = null;
				const next: any = async (r: { header: Headers }) => {
					sentTraceparent = r.header.get("traceparent");
					return { stream: false, message: OTEL_RESPONSE_MESSAGE };
				};

				await interceptor(next)(createMockRequest({ message: OTEL_REQUEST_MESSAGE }));

				const spans = exporter.getFinishedSpans();
				assert.strictEqual(spans.length, 1);
				const spanContext = spans[0]!.spanContext();
				assert.match(sentTraceparent ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
				assert.strictEqual(sentTraceparent, `00-${spanContext.traceId}-${spanContext.spanId}-01`);
			} finally {
				await shutdownProvider();
				trace.disable();
				context.disable();
				propagation.disable();
				await tracerProvider.shutdown();
			}
		});
	});

	// -----------------------------------------------------------------------
	// Streaming
	// -----------------------------------------------------------------------

	describe("streaming", () => {
		// Oracle: the package metrics guide. A streaming call that started successfully
		// carries no rpc.response.status_code (its final status is unknown when the
		// response head returns), and the aggregate size measurements of a streaming
		// call are recorded as zero.
		it("should record a streaming call as one span and one duration point without a status code, passing the messages through", async () => {
			async function* requestMessages() {
				yield { n: 1 };
			}
			async function* responseMessages() {
				yield { r: 1 };
				yield { r: 2 };
			}
			const next: any = async (_req: unknown) => ({ stream: true, message: responseMessages() });
			const handler = createOtelClientInterceptor(clientOptions())(next);
			const received: unknown[] = [];

			const observed = await observe(async () => {
				const response = (await handler(greeterRequest({ stream: true, message: requestMessages() }))) as { message: AsyncIterable<unknown> };
				for await (const message of response.message) received.push(message);
			});

			assert.deepStrictEqual(received, [{ r: 1 }, { r: 2 }]);
			const span = onlySpan(observed);
			assert.strictEqual(span.name, FULL_METHOD);
			assert.strictEqual(span.kind, SpanKind.CLIENT);
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in span.attributes), "a started stream has no final status yet");
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in (observed.durationPoints[0] ?? {})));
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_CLIENT_REQUEST_SIZE), { sum: 0, count: 1 });
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_CLIENT_RESPONSE_SIZE), { sum: 0, count: 1 });
		});

		// Counterpart of the streaming case: a unary call has its final status when the
		// response returns, so it carries rpc.response.status_code=OK, and its request
		// and response sizes are measured.
		it("should record a unary call with the status code OK and the measured message sizes", async () => {
			const handler = createOtelClientInterceptor(clientOptions())(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest({ stream: false }));
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_CLIENT_REQUEST_SIZE), { sum: 42, count: 1 });
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_CLIENT_RESPONSE_SIZE), { sum: 24, count: 1 });
		});
	});

	// -----------------------------------------------------------------------
	// Options: attributeFilter
	// -----------------------------------------------------------------------

	describe("attributeFilter", () => {
		// Oracle for the attribute set: the package metrics guide (rpc.system.name,
		// rpc.method, server.address, network.protocol.name=connect_rpc,
		// network.transport=tcp) and the OpenTelemetry RPC conventions (the deprecated
		// rpc.system and rpc.service are not part of the set). The filter's contract is
		// the option's documentation: true includes an attribute, false excludes it.
		const BASE_ATTRIBUTES = {
			[semconv.ATTR_RPC_SYSTEM_NAME]: semconv.RPC_SYSTEM_NAME_VALUE_CONNECTRPC,
			[semconv.ATTR_RPC_METHOD]: FULL_METHOD,
			[semconv.ATTR_SERVER_ADDRESS]: SERVER_ADDRESS,
			[semconv.ATTR_NETWORK_PROTOCOL_NAME]: "connect_rpc",
			[semconv.ATTR_NETWORK_TRANSPORT]: "tcp",
		};

		async function callWithAttributeFilter(attributeFilter: (key: string, value: string | number | boolean) => boolean) {
			const handler = createOtelClientInterceptor(clientOptions({ attributeFilter }))(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));
			const observed = await observe(async () => {
				await handler(greeterRequest());
			});
			return { span: onlySpan(observed), point: observed.durationPoints[0] ?? {} };
		}

		it("should keep every base attribute on the span and the metric when attributeFilter allows all", async () => {
			const { span, point } = await callWithAttributeFilter(() => true);

			assert.deepStrictEqual(span.attributes, { ...BASE_ATTRIBUTES, [semconv.ATTR_RPC_RESPONSE_STATUS_CODE]: "OK" });
			assert.deepStrictEqual(point, { ...BASE_ATTRIBUTES, [semconv.ATTR_RPC_RESPONSE_STATUS_CODE]: "OK" });
		});

		it("should drop every base attribute from the span and the metric when attributeFilter blocks all", async () => {
			const { span, point } = await callWithAttributeFilter(() => false);

			for (const key of Object.keys(BASE_ATTRIBUTES)) {
				assert.ok(!(key in span.attributes), `${key} must be excluded from the span`);
				assert.ok(!(key in point), `${key} must be excluded from the duration metric`);
			}
		});

		it("should pass each base attribute key with its value to attributeFilter", async () => {
			const received: Record<string, string | number | boolean> = {};

			await callWithAttributeFilter((key, value) => {
				received[key] = value;
				return true;
			});

			assert.deepStrictEqual(received, BASE_ATTRIBUTES);
		});

		it("should keep only the attributes attributeFilter accepts, on the span and the metric alike", async () => {
			const { span, point } = await callWithAttributeFilter((key) => key.startsWith("rpc."));

			for (const attributes of [span.attributes, point]) {
				assert.strictEqual(attributes[semconv.ATTR_RPC_SYSTEM_NAME], semconv.RPC_SYSTEM_NAME_VALUE_CONNECTRPC);
				assert.strictEqual(attributes[semconv.ATTR_RPC_METHOD], FULL_METHOD);
				assert.ok(!(semconv.ATTR_SERVER_ADDRESS in attributes), "server.address must be excluded");
				assert.ok(!(semconv.ATTR_NETWORK_PROTOCOL_NAME in attributes), "network.protocol.name must be excluded");
				assert.ok(!(semconv.ATTR_NETWORK_TRANSPORT in attributes), "network.transport must be excluded");
			}
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
		// Oracle: the otel-rpc-semconv specification (opt-in message events with
		// rpc.message.id and rpc.message.uncompressed_size; none by default) and the
		// OpenTelemetry names of the event and its attributes. For a client the request
		// is the SENT message and the response the RECEIVED one.
		const messageEvent = (type: string, id: number, size: number) => ({
			name: semconv.EVENT_RPC_MESSAGE,
			attributes: {
				[semconv.ATTR_RPC_MESSAGE_TYPE]: type,
				[semconv.ATTR_RPC_MESSAGE_ID]: id,
				[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]: size,
			},
		});

		it("should record one SENT and one RECEIVED message event with the estimated sizes for a unary call", async () => {
			const handler = createOtelClientInterceptor(clientOptions({ recordMessages: true }))(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(onlySpan(observed).events, [messageEvent("RECEIVED", 1, 24), messageEvent("SENT", 1, 42)]);
		});

		it("should record the message events of a streaming call as the streams are consumed", async () => {
			const sized = (size: number) => ({ toBinary: () => new Uint8Array(size) });
			async function* requestMessages() {
				yield sized(10);
				yield sized(20);
			}
			async function* responseMessages() {
				yield sized(30);
			}
			const next: any = async (req: { message: AsyncIterable<unknown> }) => {
				for await (const _ of req.message) {
					// The transport reads the whole request stream.
				}
				return { stream: true, message: responseMessages() };
			};
			const handler = createOtelClientInterceptor(clientOptions({ recordMessages: true }))(next);

			const observed = await observe(async () => {
				const response = (await handler(greeterRequest({ stream: true, message: requestMessages() }))) as { message: AsyncIterable<unknown> };
				for await (const _ of response.message) {
					// Draining the response stream ends the span.
				}
			});

			// The collector returns events in its own canonical order, so compare as a set.
			const describeEvent = (e: { attributes: Record<string, unknown> }) =>
				`${e.attributes[semconv.ATTR_RPC_MESSAGE_TYPE]} #${e.attributes[semconv.ATTR_RPC_MESSAGE_ID]} size ${e.attributes[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]}`;
			assert.deepStrictEqual(onlySpan(observed).events.map(describeEvent).sort(), [
				"RECEIVED #1 size 30",
				"SENT #1 size 10",
				"SENT #2 size 20",
			]);
		});

		for (const [description, options] of [
			["recordMessages=false", { recordMessages: false }],
			["no recordMessages option (the default)", {}],
		] as const) {
			it(`should record no message events with ${description}`, async () => {
				const handler = createOtelClientInterceptor(clientOptions(options))(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

				const observed = await observe(async () => {
					await handler(greeterRequest());
				});

				assert.deepStrictEqual(onlySpan(observed).events, []);
			});
		}
	});

	// -----------------------------------------------------------------------
	// Message size estimation
	// -----------------------------------------------------------------------

	describe("message size estimation", () => {
		// Oracle: the package metrics guide: the request size histogram holds the estimated
		// serialized size of a unary message (here the length of its binary form); a
		// message whose size cannot be estimated is counted as zero bytes, and the call
		// is still recorded.
		async function requestSizeOf(message: unknown) {
			const handler = createOtelClientInterceptor(clientOptions())(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));
			let response: unknown;
			const observed = await observe(async () => {
				const request = greeterRequest();
				// Set after creation: the fixture replaces a null or undefined message with {}.
				request.message = message;
				response = await handler(request);
			});
			assert.ok(response, "the call goes through");
			return histogramTotals(observed, semconv.METRIC_RPC_CLIENT_REQUEST_SIZE);
		}

		it("should record the length of toBinary() as the request size", async () => {
			assert.deepStrictEqual(await requestSizeOf({ toBinary: () => new Uint8Array(100) }), { sum: 100, count: 1 });
		});

		it("should record zero as the request size of a message without toBinary()", async () => {
			assert.deepStrictEqual(await requestSizeOf({ someField: "value" }), { sum: 0, count: 1 });
		});

		it("should record zero as the request size of a null message", async () => {
			assert.deepStrictEqual(await requestSizeOf(null), { sum: 0, count: 1 });
		});
	});

	// -----------------------------------------------------------------------
	// Combined options
	// -----------------------------------------------------------------------

	describe("combined options", () => {
		it("should apply every option at once", async () => {
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

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_SERVER_ADDRESS], "test-host");
			assert.strictEqual(span.attributes[semconv.ATTR_SERVER_PORT], 3000);
			assert.deepStrictEqual(
				span.events.map((e) => e.attributes[semconv.ATTR_RPC_MESSAGE_TYPE]).sort(),
				["RECEIVED", "SENT"],
			);
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_SERVER_PORT], 3000);
		});

		it("should record nothing and hand the response through when filter rejects the call, whatever other options say", async () => {
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
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			assert.deepStrictEqual(observed.spans, []);
			assert.deepStrictEqual(observed.metrics, []);
		});
	});
});
