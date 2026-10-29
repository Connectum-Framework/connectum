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
import { hostname } from "node:os";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import { createOtelInterceptor } from "../../src/interceptor.ts";
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

interface ServerObserved extends Observed {
	/** Attributes of every recorded point of the server call-duration histogram. */
	durationPoints: Array<Record<string, unknown>>;
}

async function observe(body: () => Promise<void>): Promise<ServerObserved> {
	const observed = await observeTelemetry(body);
	return { ...observed, durationPoints: pointAttributes(observed, semconv.METRIC_RPC_SERVER_CALL_DURATION) };
}

/** Request for the conventions' example method, as the interceptor sees it. */
function greeterRequest(extra: { stream?: boolean } = {}) {
	return createMockRequest({ service: SERVICE, method: METHOD, message: OTEL_REQUEST_MESSAGE, ...extra });
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
		it("should hand the response through and record one server span and one duration point for a unary call", async () => {
			const expectedResponse = { stream: false, message: OTEL_RESPONSE_MESSAGE };
			const handler = createOtelInterceptor()((async () => expectedResponse) as never);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			// Oracle: the OpenTelemetry RPC conventions for Connect: the span is named by the
			// fully qualified method and carries rpc.system.name=connectrpc and rpc.method; a
			// successful unary call carries rpc.response.status_code=OK and no error.type.
			const span = onlySpan(observed);
			assert.strictEqual(span.name, FULL_METHOD);
			assert.strictEqual(span.kind, SpanKind.SERVER);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_SYSTEM_NAME], semconv.RPC_SYSTEM_NAME_VALUE_CONNECTRPC);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_METHOD], FULL_METHOD);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.ok(!(semconv.ATTR_ERROR_TYPE in span.attributes), "a successful call must not carry error.type");
			// Instrumentation never reports OK: a successful span keeps the default UNSET status.
			assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
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

			// A failed call carries the Connect error-code name as rpc.response.status_code
			// and error.type, on the span and on the duration metric.
			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
			// A failure is the only case that sets a span status: ERROR with the error message.
			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
			assert.strictEqual(span.status.message, "[not_found] not found");
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
		});

		// Oracle: the exception event conventions: exception.type is the type or class name of
		// the exception. The OpenTelemetry SDK reads a numeric `code` property of the
		// exception before its `name`, which gave "5" for a ConnectError with Code.NotFound.
		it("should record the class name of a ConnectError, not its numeric code, as exception.type", async () => {
			const next: any = async (_req: unknown) => { throw new ConnectError("no such user", Code.NotFound); };
			const handler = createOtelInterceptor()(next);

			const observed = await observe(async () => {
				await assert.rejects(() => handler(greeterRequest()));
			});

			const [event] = onlySpan(observed).events.filter((e) => e.name === "exception");
			assert.ok(event, "the failure is recorded as an exception event");
			assert.strictEqual(event.attributes[semconv.ATTR_EXCEPTION_TYPE], "ConnectError");
			assert.strictEqual(event.attributes[semconv.ATTR_EXCEPTION_MESSAGE], "[not_found] no such user");
			assert.strictEqual(typeof event.attributes[semconv.ATTR_EXCEPTION_STACKTRACE], "string");
		});

		it("should record the empty-named class of an anonymous error with a non-empty error.type", async () => {
			const Anonymous = (() => class extends Error {})();
			const next: any = async (_req: unknown) => { throw new Anonymous("x"); };
			const handler = createOtelInterceptor()(next);

			const observed = await observe(async () => {
				await assert.rejects(() => handler(greeterRequest()));
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_ERROR_TYPE], "Error");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_ERROR_TYPE], "Error");
		});

		// The Connect spelling of code 1 has one L (as the Connect protocol, Connect-ES and
		// otelconnect-go write it); the gRPC spelling with two Ls is never produced.
		it("should report a canceled call as CANCELED with one L and an ERROR span status", async () => {
			const next: any = async (_req: unknown) => { throw new ConnectError("stopped", Code.Canceled); };
			const handler = createOtelInterceptor()(next);

			const observed = await observe(async () => {
				await assert.rejects(() => handler(greeterRequest()));
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "CANCELED");
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "CANCELED");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "CANCELED");
			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
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
		// Oracle: the W3C Trace Context example traceparent
		// (version-traceid-parentid-flags) and the package guide on tracing: the receiver
		// does not trust the remote parent by default, it starts a new trace and links to
		// the extracted remote span context; with trustRemote the span joins the remote
		// trace as the child of the remote span.
		const REMOTE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
		const REMOTE_SPAN_ID = "00f067aa0ba902b7";
		const TRACEPARENT = `00-${REMOTE_TRACE_ID}-${REMOTE_SPAN_ID}-01`;

		async function callWithTraceparent(options: Parameters<typeof createOtelInterceptor>[0], traceparent: string | undefined) {
			const handler = createOtelInterceptor(options)(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));
			const headers = new Headers();
			if (traceparent !== undefined) headers.set("traceparent", traceparent);
			const observed = await observe(async () => {
				await handler(createMockRequest({ service: SERVICE, method: METHOD, message: OTEL_REQUEST_MESSAGE, headers }));
			});
			const span = onlySpan(observed);
			return { span, links: observed.links[span.spanId] };
		}

		it("should make the server span a child of the remote span when trustRemote=true", async () => {
			const { span, links } = await callWithTraceparent({ trustRemote: true }, TRACEPARENT);

			assert.strictEqual(span.traceId, REMOTE_TRACE_ID);
			assert.strictEqual(span.parentSpanId, REMOTE_SPAN_ID);
			assert.deepStrictEqual(links, [], "a trusted remote parent is a parent, not a link");
		});

		it("should start a new trace linked to the remote span when trustRemote=false", async () => {
			const { span, links } = await callWithTraceparent({ trustRemote: false }, TRACEPARENT);

			assert.notStrictEqual(span.traceId, REMOTE_TRACE_ID);
			assert.strictEqual(span.parentSpanId, undefined, "an untrusted remote span must not become the parent");
			assert.deepStrictEqual(links, [{ traceId: REMOTE_TRACE_ID, spanId: REMOTE_SPAN_ID }]);
		});

		it("should not trust the remote parent by default", async () => {
			const { span, links } = await callWithTraceparent({}, TRACEPARENT);

			assert.notStrictEqual(span.traceId, REMOTE_TRACE_ID);
			assert.strictEqual(span.parentSpanId, undefined);
			assert.deepStrictEqual(links, [{ traceId: REMOTE_TRACE_ID, spanId: REMOTE_SPAN_ID }]);
		});

		// A request without a usable traceparent has nothing to extract: the span is a
		// root span and carries no link, whatever trustRemote says.
		for (const [description, traceparent] of [
			["has no traceparent header", undefined],
			["has a malformed traceparent header", "not-a-traceparent"],
		] as const) {
			for (const trustRemote of [true, false]) {
				it(`should record a root span without links when the request ${description} and trustRemote=${trustRemote}`, async () => {
					const { span, links } = await callWithTraceparent({ trustRemote }, traceparent);

					assert.strictEqual(span.parentSpanId, undefined);
					assert.deepStrictEqual(links, []);
				});
			}
		}
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
				yield { n: 2 };
			}
			async function* responseMessages() {
				yield { r: 1 };
				yield { r: 2 };
				yield { r: 3 };
			}
			const next: any = async (_req: unknown) => ({ stream: true, message: responseMessages() });
			const handler = createOtelInterceptor()(next);
			const received: unknown[] = [];

			const observed = await observe(async () => {
				const response = (await handler(
					createMockRequest({ service: SERVICE, method: METHOD, stream: true, message: requestMessages() }),
				)) as { message: AsyncIterable<unknown> };
				for await (const message of response.message) received.push(message);
			});

			assert.deepStrictEqual(received, [{ r: 1 }, { r: 2 }, { r: 3 }]);
			const span = onlySpan(observed);
			assert.strictEqual(span.name, FULL_METHOD);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_METHOD], FULL_METHOD);
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in span.attributes), "a started stream has no final status yet");
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in (observed.durationPoints[0] ?? {})));
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_SERVER_REQUEST_SIZE), { sum: 0, count: 1 });
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_SERVER_RESPONSE_SIZE), { sum: 0, count: 1 });
		});

		// Counterpart of the streaming case: a unary call has its final status when the
		// response returns, so it carries rpc.response.status_code=OK, and its request
		// and response sizes are measured.
		it("should record a unary call with the status code OK and the measured message sizes", async () => {
			const handler = createOtelInterceptor()(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(createMockRequest({ service: SERVICE, method: METHOD, stream: false, message: OTEL_REQUEST_MESSAGE }));
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "OK");
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_SERVER_REQUEST_SIZE), { sum: 42, count: 1 });
			assert.deepStrictEqual(histogramTotals(observed, semconv.METRIC_RPC_SERVER_RESPONSE_SIZE), { sum: 24, count: 1 });
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
		const SERVER_ADDRESS = "greeter.example.com";
		const BASE_ATTRIBUTES = {
			[semconv.ATTR_RPC_SYSTEM_NAME]: semconv.RPC_SYSTEM_NAME_VALUE_CONNECTRPC,
			[semconv.ATTR_RPC_METHOD]: FULL_METHOD,
			[semconv.ATTR_SERVER_ADDRESS]: SERVER_ADDRESS,
			[semconv.ATTR_NETWORK_PROTOCOL_NAME]: "connect_rpc",
			[semconv.ATTR_NETWORK_TRANSPORT]: "tcp",
		};

		async function callWithAttributeFilter(attributeFilter: (key: string, value: string | number | boolean) => boolean) {
			const handler = createOtelInterceptor({ serverAddress: SERVER_ADDRESS, attributeFilter })(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));
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
			// Only allow rpc.* attributes, block server.* and network.*
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
		// Oracle: the option documentation (serverAddress overrides server.address,
		// serverPort is the opt-in server.port) and the metrics guide (both attributes
		// appear on spans and on RPC metrics).
		it("should report serverAddress as server.address on the span and the metric", async () => {
			const handler = createOtelInterceptor({ serverAddress: "my-host.example.com" })(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_SERVER_ADDRESS], "my-host.example.com");
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_SERVER_ADDRESS], "my-host.example.com");
		});

		it("should report serverPort as the numeric server.port on the span and the metric", async () => {
			const handler = createOtelInterceptor({ serverPort: 5000 })(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_SERVER_PORT], 5000);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_SERVER_PORT], 5000);
		});

		// The base attributes are built before attributeFilter runs, so the filter is the
		// one place that shows whether serverPort took part in them at all.
		it("should hand server.port to attributeFilter, and drop it from the span and the metric when the filter refuses it", async () => {
			const received: Array<[string, string | number | boolean]> = [];
			const handler = createOtelInterceptor({
				serverPort: 5000,
				attributeFilter: (key, value) => {
					received.push([key, value]);
					return key !== semconv.ATTR_SERVER_PORT;
				},
			})(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(
				received.filter(([key]) => key === semconv.ATTR_SERVER_PORT),
				[[semconv.ATTR_SERVER_PORT, 5000]],
			);
			assert.ok(!(semconv.ATTR_SERVER_PORT in onlySpan(observed).attributes), "a refused server.port must not reach the span");
			assert.ok(observed.durationPoints.length > 0, "the duration metric must be recorded");
			assert.ok(!(semconv.ATTR_SERVER_PORT in (observed.durationPoints[0] ?? {})), "a refused server.port must not reach the metric");
		});

		it("should leave server.port off the span and the metric when serverPort is not given", async () => {
			const handler = createOtelInterceptor({ serverAddress: "my-host.example.com" })(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.ok(!(semconv.ATTR_SERVER_PORT in onlySpan(observed).attributes), "server.port is opt-in");
			assert.ok(!(semconv.ATTR_SERVER_PORT in (observed.durationPoints[0] ?? {})), "server.port is opt-in");
		});
	});

	// -----------------------------------------------------------------------
	// Options: recordMessages
	// -----------------------------------------------------------------------

	describe("recordMessages", () => {
		// Oracle: the otel-rpc-semconv specification (opt-in message events: a unary call
		// with recordMessages=true records one RECEIVED and one SENT event, each with
		// rpc.message.id and rpc.message.uncompressed_size; without the option no events)
		// and the OpenTelemetry names of the event and its attributes.
		const messageEvent = (type: string, id: number, size: number) => ({
			name: semconv.EVENT_RPC_MESSAGE,
			attributes: {
				[semconv.ATTR_RPC_MESSAGE_TYPE]: type,
				[semconv.ATTR_RPC_MESSAGE_ID]: id,
				[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]: size,
			},
		});

		it("should record one RECEIVED and one SENT message event with the estimated sizes for a unary call", async () => {
			const handler = createOtelInterceptor({ recordMessages: true })(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(onlySpan(observed).events, [messageEvent("RECEIVED", 1, 42), messageEvent("SENT", 1, 24)]);
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
					// The handler reads the whole request stream.
				}
				return { stream: true, message: responseMessages() };
			};
			const handler = createOtelInterceptor({ recordMessages: true })(next);

			const observed = await observe(async () => {
				const response = (await handler(
					createMockRequest({ service: SERVICE, method: METHOD, stream: true, message: requestMessages() }),
				)) as { message: AsyncIterable<unknown> };
				for await (const _ of response.message) {
					// Draining the response stream ends the span.
				}
			});

			// The collector returns events in its own canonical order, so compare as a set.
			const describeEvent = (e: { attributes: Record<string, unknown> }) =>
				`${e.attributes[semconv.ATTR_RPC_MESSAGE_TYPE]} #${e.attributes[semconv.ATTR_RPC_MESSAGE_ID]} size ${e.attributes[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]}`;
			assert.deepStrictEqual(onlySpan(observed).events.map(describeEvent).sort(), [
				"RECEIVED #1 size 10",
				"RECEIVED #2 size 20",
				"SENT #1 size 30",
			]);
		});

		for (const [description, options] of [
			["recordMessages=false", { recordMessages: false }],
			["no recordMessages option (the default)", {}],
		] as const) {
			it(`should record no message events with ${description}`, async () => {
				const handler = createOtelInterceptor(options)(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

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
			const handler = createOtelInterceptor()(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));
			let response: unknown;
			const observed = await observe(async () => {
				const request = createMockRequest({ service: SERVICE, method: METHOD });
				// Set after creation: the fixture replaces a null or undefined message with {}.
				request.message = message;
				response = await handler(request);
			});
			assert.ok(response, "the call goes through");
			return histogramTotals(observed, semconv.METRIC_RPC_SERVER_REQUEST_SIZE);
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

		it("should record zero as the request size of an empty binary message", async () => {
			assert.deepStrictEqual(await requestSizeOf({ toBinary: () => new Uint8Array(0) }), { sum: 0, count: 1 });
		});
	});

	// -----------------------------------------------------------------------
	// Call duration unit
	// -----------------------------------------------------------------------

	describe("call duration", () => {
		// Oracle: the OpenTelemetry RPC metrics conventions: rpc.server.call.duration is
		// measured in seconds (unit "s"). A handler that takes about 50 ms must record
		// about 0.05, not 50 (milliseconds under a seconds unit). The bounds only need to
		// tell 0.05 from 50, so they are wide enough to survive a loaded machine.
		const HANDLER_DELAY_MS = 50;
		const MIN_SECONDS = 0.04;
		const MAX_SECONDS = 10;

		function assertSeconds(observed: ServerObserved) {
			const { sum, count } = histogramTotals(observed, semconv.METRIC_RPC_SERVER_CALL_DURATION);
			assert.strictEqual(count, 1);
			assert.ok(sum >= MIN_SECONDS && sum < MAX_SECONDS, `a ${HANDLER_DELAY_MS} ms handler must record seconds, recorded ${sum}`);
		}

		const slowSuccess: any = async (_req: unknown) => {
			await delay(HANDLER_DELAY_MS);
			return { stream: false, message: OTEL_RESPONSE_MESSAGE };
		};
		const slowFailure: any = async (_req: unknown) => {
			await delay(HANDLER_DELAY_MS);
			throw new ConnectError("too slow", Code.DeadlineExceeded);
		};

		it("should record the duration of a successful call in seconds", async () => {
			const handler = createOtelInterceptor()(slowSuccess);

			assertSeconds(await observe(async () => { await handler(greeterRequest()); }));
		});

		it("should record the duration of a successful call in seconds when tracing is off", async () => {
			const handler = createOtelInterceptor({ withoutTracing: true })(slowSuccess);

			assertSeconds(await observe(async () => { await handler(greeterRequest()); }));
		});

		it("should record the duration of a failed call in seconds", async () => {
			const handler = createOtelInterceptor()(slowFailure);

			assertSeconds(await observe(async () => { await assert.rejects(() => handler(greeterRequest())); }));
		});

		it("should record the duration of a failed call in seconds when tracing is off", async () => {
			const handler = createOtelInterceptor({ withoutTracing: true })(slowFailure);

			assertSeconds(await observe(async () => { await assert.rejects(() => handler(greeterRequest())); }));
		});
	});

	// -----------------------------------------------------------------------
	// Default options
	// -----------------------------------------------------------------------

	describe("default options", () => {
		// Oracle: the option documentation: server.address defaults to the host name
		// (os.hostname()), server.port is opt-in, message events are off by default; both
		// tracing and metrics are on.
		for (const [description, options] of [
			["no options", undefined],
			["an empty options object", {}],
		] as const) {
			it(`should instrument with the documented defaults when created with ${description}`, async () => {
				const handler = createOtelInterceptor(options)(createMockNext({ message: OTEL_RESPONSE_MESSAGE }));

				const observed = await observe(async () => {
					await handler(greeterRequest());
				});

				const span = onlySpan(observed);
				assert.strictEqual(span.attributes[semconv.ATTR_SERVER_ADDRESS], hostname());
				assert.ok(!(semconv.ATTR_SERVER_PORT in span.attributes), "server.port is opt-in");
				assert.deepStrictEqual(span.events, []);
				assert.strictEqual(observed.durationPoints.length, 1);
				assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_SERVER_ADDRESS], hostname());
			});
		}
	});

	// -----------------------------------------------------------------------
	// Combined options
	// -----------------------------------------------------------------------

	describe("combined options", () => {
		it("should apply every option at once", async () => {
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

			const observed = await observe(async () => {
				await handler(
					createMockRequest({
						service: SERVICE,
						method: METHOD,
						message: OTEL_REQUEST_MESSAGE,
						headers: new Headers({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }),
					}),
				);
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.attributes[semconv.ATTR_SERVER_ADDRESS], "test-host");
			assert.strictEqual(span.attributes[semconv.ATTR_SERVER_PORT], 3000);
			assert.strictEqual(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736", "trustRemote joins the remote trace");
			assert.strictEqual(span.parentSpanId, "00f067aa0ba902b7");
			assert.deepStrictEqual(
				span.events.map((e) => e.attributes[semconv.ATTR_RPC_MESSAGE_TYPE]),
				["RECEIVED", "SENT"],
			);
			assert.strictEqual(observed.durationPoints.length, 1);
			assert.strictEqual(observed.durationPoints[0]?.[semconv.ATTR_SERVER_PORT], 3000);
		});

		it("should record nothing and hand the response through when filter rejects the call, whatever other options say", async () => {
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
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(greeterRequest());
			});

			assert.strictEqual(response, expectedResponse);
			assert.deepStrictEqual(observed.spans, []);
			assert.deepStrictEqual(observed.metrics, []);
		});

		it("should still consult filter and call next() once when tracing and metrics are both disabled", async () => {
			const filterCalls: unknown[] = [];
			let nextCalls = 0;
			const interceptor = createOtelInterceptor({
				withoutTracing: true,
				withoutMetrics: true,
				filter: (call) => {
					filterCalls.push(call);
					return false;
				},
			});
			const next: any = async (_req: unknown) => {
				nextCalls++;
				return { stream: false, message: {} };
			};
			const handler = interceptor(next);

			const observed = await observe(async () => {
				await handler(greeterRequest());
			});

			assert.deepStrictEqual(filterCalls, [{ service: SERVICE, method: METHOD, stream: false }]);
			assert.strictEqual(nextCalls, 1);
			assert.deepStrictEqual(observed.spans, []);
			assert.deepStrictEqual(observed.metrics, []);
		});
	});
});
