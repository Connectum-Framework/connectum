/**
 * Streaming support unit tests
 *
 * Tests streaming-related functionality across the @connectum/otel package:
 * - wrapAsyncIterable() from shared.ts -- core streaming wrapper
 * - Streaming request/response wrapping in server interceptor (createOtelInterceptor)
 * - Streaming request/response wrapping in client interceptor (createOtelClientInterceptor)
 * - estimateMessageSize() of a message object that is reused and changes
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createMockRequest, type NormalizedSpan } from "@connectum/testing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";
import { estimateMessageSize, wrapAsyncIterable } from "../../src/shared.ts";
import { histogramTotals, type Observed, observe, onlySpan, pointAttributes } from "./observe.ts";

// ---------------------------------------------------------------------------
// Otel-specific default message (for size estimation tests)
// ---------------------------------------------------------------------------

const OTEL_REQUEST_MESSAGE = { toBinary: () => new Uint8Array(42) };

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock span that captures addEvent calls for assertion.
 */
function createMockSpan() {
	const events: Array<{ name: string; attributes: Record<string, unknown> | undefined }> = [];
	const recordedExceptions: unknown[] = [];
	const statuses: Array<{ code: number; message?: string }> = [];
	let ended = false;
	let endCount = 0;
	return {
		span: {
			addEvent(name: string, attributes?: Record<string, unknown>) {
				events.push({ name, attributes });
			},
			recordException(error: unknown) {
				recordedExceptions.push(error);
			},
			setStatus(status: { code: number; message?: string }) {
				statuses.push(status);
			},
			end() {
				ended = true;
				endCount++;
			},
		} as any,
		events,
		recordedExceptions,
		statuses,
		get ended() { return ended; },
		get endCount() { return endCount; },
	};
}

/**
 * Creates an async generator yielding the given items.
 */
async function* mockAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
	for (const item of items) {
		yield item;
	}
}

/**
 * Creates an async generator that yields items then throws an error.
 */
async function* mockAsyncIterableWithError<T>(items: T[], error: Error): AsyncGenerator<T> {
	for (const item of items) {
		yield item;
	}
	throw error;
}

/**
 * Collects all items from an async iterable into an array.
 */
async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		result.push(item);
	}
	return result;
}

// ---------------------------------------------------------------------------
// wrapAsyncIterable()
// ---------------------------------------------------------------------------

describe("wrapAsyncIterable", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	// -----------------------------------------------------------------------
	// Basic yielding
	// -----------------------------------------------------------------------

	it("should yield all messages from source iterable", async () => {
		const { span } = createMockSpan();
		const items = ["msg1", "msg2", "msg3"];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", false);
		const collected = await collectAll(wrapped);

		assert.deepStrictEqual(collected, items);
	});

	it("should yield objects preserving identity", async () => {
		const { span } = createMockSpan();
		const obj1 = { id: 1, toBinary: () => new Uint8Array(10) };
		const obj2 = { id: 2, toBinary: () => new Uint8Array(20) };
		const items = [obj1, obj2];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", false);
		const collected = await collectAll(wrapped);

		assert.strictEqual(collected.length, 2);
		assert.strictEqual(collected[0], obj1);
		assert.strictEqual(collected[1], obj2);
	});

	// -----------------------------------------------------------------------
	// Empty streams
	// -----------------------------------------------------------------------

	it("should handle empty streams (zero messages)", async () => {
		const { span, events } = createMockSpan();

		const wrapped = wrapAsyncIterable(mockAsyncIterable([]), span, "RECEIVED", true);
		const collected = await collectAll(wrapped);

		assert.strictEqual(collected.length, 0);
		assert.strictEqual(events.length, 0);
	});

	// -----------------------------------------------------------------------
	// Message sequence numbers
	// -----------------------------------------------------------------------

	it("should track message sequence numbers starting at 1", async () => {
		const { span, events } = createMockSpan();
		const items = [
			{ toBinary: () => new Uint8Array(10) },
			{ toBinary: () => new Uint8Array(20) },
			{ toBinary: () => new Uint8Array(30) },
		];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", true);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.id"], 1);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.id"], 2);
		assert.strictEqual(events[2]!.attributes?.["rpc.message.id"], 3);
	});

	// -----------------------------------------------------------------------
	// Size estimation
	// -----------------------------------------------------------------------

	it("should estimate size for streaming messages using estimateMessageSize", async () => {
		const { span, events } = createMockSpan();
		const items = [
			{ toBinary: () => new Uint8Array(10) },
			{ toBinary: () => new Uint8Array(50) },
		];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", true);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.uncompressed_size"], 10);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.uncompressed_size"], 50);
	});

	// semconv defines rpc.message.uncompressed_size as a byte count and does not say
	// what to record when the size is unknown. Connectum records 0 in that case
	// (documented on estimateMessageSize); this pins that decision, not a standard.
	it("should record Connectum's 0 for the size of messages without toBinary", async () => {
		const { span, events } = createMockSpan();
		const items = [{ someField: "value" }, { anotherField: 42 }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", true);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.uncompressed_size"], 0);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.uncompressed_size"], 0);
	});

	// -----------------------------------------------------------------------
	// recordMessages toggle
	// -----------------------------------------------------------------------

	it("should not add events when recordMessages is false", async () => {
		const { span, events } = createMockSpan();
		const items = [
			{ toBinary: () => new Uint8Array(10) },
			{ toBinary: () => new Uint8Array(20) },
		];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", false);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 0);
	});

	it("should add events when recordMessages is true", async () => {
		const { span, events } = createMockSpan();
		const items = [
			{ toBinary: () => new Uint8Array(15) },
		];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", true);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.name, "rpc.message");
	});

	// -----------------------------------------------------------------------
	// Span event attributes (OTel semantic conventions)
	// -----------------------------------------------------------------------

	it("should use event name 'rpc.message' with correct attribute keys", async () => {
		const { span, events } = createMockSpan();
		const items = [{ toBinary: () => new Uint8Array(33) }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", true);
		await collectAll(wrapped);

		// The event and its attribute names come from the semantic-conventions registry:
		// the otel-rpc-semconv specification keeps the message events, and the registry
		// still defines them (as deprecated, with no replacement).
		assert.deepStrictEqual(events, [
			{
				name: semconv.EVENT_RPC_MESSAGE,
				attributes: {
					[semconv.ATTR_RPC_MESSAGE_TYPE]: semconv.RPC_MESSAGE_TYPE_VALUE_RECEIVED,
					[semconv.ATTR_RPC_MESSAGE_ID]: 1,
					[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]: 33,
				},
			},
		]);
	});

	it("should set rpc.message.type to SENT for outgoing messages", async () => {
		const { span, events } = createMockSpan();
		const items = [{ toBinary: () => new Uint8Array(5) }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", true);
		await collectAll(wrapped);

		assert.strictEqual(events[0]!.attributes?.[semconv.ATTR_RPC_MESSAGE_TYPE], semconv.RPC_MESSAGE_TYPE_VALUE_SENT);
	});

	it("should set rpc.message.type to RECEIVED for incoming messages", async () => {
		const { span, events } = createMockSpan();
		const items = [{ toBinary: () => new Uint8Array(5) }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", true);
		await collectAll(wrapped);

		assert.strictEqual(events[0]!.attributes?.[semconv.ATTR_RPC_MESSAGE_TYPE], semconv.RPC_MESSAGE_TYPE_VALUE_RECEIVED);
	});

	// -----------------------------------------------------------------------
	// Error handling mid-stream
	// -----------------------------------------------------------------------

	it("should handle stream errors mid-flight (re-throws error)", async () => {
		const { span, events } = createMockSpan();
		const error = new Error("stream interrupted");
		const items = [
			{ toBinary: () => new Uint8Array(10) },
			{ toBinary: () => new Uint8Array(20) },
		];

		const wrapped = wrapAsyncIterable(
			mockAsyncIterableWithError(items, error),
			span,
			"RECEIVED",
			true,
		);

		const collected: unknown[] = [];
		await assert.rejects(async () => {
			for await (const msg of wrapped) {
				collected.push(msg);
			}
		}, { message: "stream interrupted" });

		// Should have yielded the items before the error
		assert.strictEqual(collected.length, 2);

		// Should have 2 message events only (no error event)
		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.id"], 1);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.id"], 2);
	});

	it("should re-throw error even when recordMessages is false", async () => {
		const { span, events } = createMockSpan();
		const error = new Error("unexpected failure");

		const wrapped = wrapAsyncIterable(
			mockAsyncIterableWithError([], error),
			span,
			"SENT",
			false,
		);

		await assert.rejects(async () => {
			for await (const _msg of wrapped) {
				// no items before error
			}
		}, { message: "unexpected failure" });

		// No events when recordMessages is false (error event removed)
		assert.strictEqual(events.length, 0);
	});

	it("should re-throw the original error from the source iterable", async () => {
		const { span } = createMockSpan();
		const originalError = new TypeError("type mismatch in stream");

		const wrapped = wrapAsyncIterable(
			mockAsyncIterableWithError([], originalError),
			span,
			"RECEIVED",
			false,
		);

		await assert.rejects(async () => {
			for await (const _msg of wrapped) {
				// no items
			}
		}, (err: unknown) => {
			assert.ok(err instanceof TypeError);
			assert.strictEqual((err as TypeError).message, "type mismatch in stream");
			return true;
		});
	});

	// -----------------------------------------------------------------------
	// Multiple messages with varied sizes
	// -----------------------------------------------------------------------

	it("should track correct sizes for multiple heterogeneous messages", async () => {
		const { span, events } = createMockSpan();
		const items = [
			{ toBinary: () => new Uint8Array(0) },
			{ toBinary: () => new Uint8Array(100) },
			{ someField: "no toBinary" },
			{ toBinary: () => new Uint8Array(255) },
		];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", true);
		await collectAll(wrapped);

		assert.strictEqual(events.length, 4);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.uncompressed_size"], 0);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.uncompressed_size"], 100);
		assert.strictEqual(events[2]!.attributes?.["rpc.message.uncompressed_size"], 0);
		assert.strictEqual(events[3]!.attributes?.["rpc.message.uncompressed_size"], 255);
	});

	// -----------------------------------------------------------------------
	// endSpanOnComplete
	// -----------------------------------------------------------------------

	it("should leave the span status unset when the stream completes normally", async () => {
		const mock = createMockSpan();
		const items = ["msg1", "msg2"];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), mock.span, "RECEIVED", false, true);
		await collectAll(wrapped);

		assert.strictEqual(mock.endCount, 1);
		assert.strictEqual(mock.recordedExceptions.length, 0);
		// Neither ERROR nor OK: instrumentation never reports OK, so no status is set at all.
		assert.deepStrictEqual(mock.statuses, []);
	});

	it("should record exception and set ERROR status when stream errors with endSpanOnComplete=true", async () => {
		const mock = createMockSpan();
		const error = new Error("stream failed");

		const wrapped = wrapAsyncIterable(
			mockAsyncIterableWithError([], error),
			mock.span,
			"SENT",
			false,
			true,
		);

		await assert.rejects(async () => {
			for await (const _msg of wrapped) {
				// no items
			}
		}, { message: "stream failed" });

		assert.strictEqual(mock.ended, true);
		assert.strictEqual(mock.recordedExceptions.length, 1);
		assert.strictEqual((mock.recordedExceptions[0] as Error).message, "stream failed");
		assert.deepStrictEqual(mock.statuses, [{ code: SpanStatusCode.ERROR, message: "stream failed" }]);
	});

	it("should NOT end span when endSpanOnComplete is false (default)", async () => {
		const mock = createMockSpan();
		const items = ["msg1"];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), mock.span, "RECEIVED", false);
		await collectAll(wrapped);

		assert.strictEqual(mock.ended, false);
	});

	it("should end span on early break (generator.return()) with endSpanOnComplete=true", async () => {
		const mock = createMockSpan();

		async function* infiniteStream() {
			let i = 0;
			while (true) {
				yield `msg-${i++}`;
			}
		}

		const wrapped = wrapAsyncIterable(infiniteStream(), mock.span, "RECEIVED", false, true);

		// Consume only one message, then break
		for await (const _msg of wrapped) {
			break;
		}

		// A consumer that stops reading is not an operation error: the span ends once,
		// records no exception and leaves the status unset (neither ERROR nor OK).
		assert.strictEqual(mock.endCount, 1);
		assert.strictEqual(mock.recordedExceptions.length, 0);
		assert.deepStrictEqual(mock.statuses, []);
	});
});

// ---------------------------------------------------------------------------
// estimateMessageSize() of a message that changes
// ---------------------------------------------------------------------------

describe("estimateMessageSize of a reused message object", () => {
	// A protobuf message is a mutable object and applications reuse one request object
	// across calls. A size remembered per object would report the first call's size for
	// every later call, so each estimate measures the message as it is now.
	it("should measure a message again after it changed", () => {
		let length = 10;
		const message = { toBinary: () => new Uint8Array(length) };

		assert.strictEqual(estimateMessageSize(message), 10);
		length = 25;
		assert.strictEqual(estimateMessageSize(message), 25);
	});

	it("should call toBinary separately for different message objects", () => {
		let callCount = 0;
		const messageA = {
			toBinary: () => {
				callCount++;
				return new Uint8Array(10);
			},
		};
		const messageB = {
			toBinary: () => {
				callCount++;
				return new Uint8Array(20);
			},
		};

		const sizeA = estimateMessageSize(messageA);
		const sizeB = estimateMessageSize(messageB);

		assert.strictEqual(sizeA, 10);
		assert.strictEqual(sizeB, 20);
		assert.strictEqual(callCount, 2);
	});
});

// ---------------------------------------------------------------------------
// Streaming in the server and client interceptors
// ---------------------------------------------------------------------------

// Oracle: the otel-rpc-semconv specification (opt-in message events carrying a
// direction, a sequence number and the estimated size), the OpenTelemetry names of
// the event and its attributes, and the package metrics guide: a streaming call that
// started successfully carries no rpc.response.status_code and its aggregate size
// measurements are zero. The server receives the request and sends the response, the
// client sends the request and receives the response.
interface Side {
	name: string;
	create: (options: { recordMessages?: boolean; withoutTracing?: boolean; withoutMetrics?: boolean; filter?: () => boolean }) => Interceptor;
	spanKind: SpanKind;
	requestDirection: "RECEIVED" | "SENT";
	responseDirection: "RECEIVED" | "SENT";
	durationMetric: string;
	requestSizeMetric: string;
	responseSizeMetric: string;
}

const SIDES: Side[] = [
	{
		name: "createOtelInterceptor",
		create: (options) => createOtelInterceptor(options),
		spanKind: SpanKind.SERVER,
		requestDirection: "RECEIVED",
		responseDirection: "SENT",
		durationMetric: semconv.METRIC_RPC_SERVER_CALL_DURATION,
		requestSizeMetric: semconv.METRIC_RPC_SERVER_REQUEST_SIZE,
		responseSizeMetric: semconv.METRIC_RPC_SERVER_RESPONSE_SIZE,
	},
	{
		name: "createOtelClientInterceptor",
		create: (options) => createOtelClientInterceptor({ serverAddress: "api.example.com", ...options }),
		spanKind: SpanKind.CLIENT,
		requestDirection: "SENT",
		responseDirection: "RECEIVED",
		durationMetric: semconv.METRIC_RPC_CLIENT_CALL_DURATION,
		requestSizeMetric: semconv.METRIC_RPC_CLIENT_REQUEST_SIZE,
		responseSizeMetric: semconv.METRIC_RPC_CLIENT_RESPONSE_SIZE,
	},
];

const sized = (size: number) => ({ toBinary: () => new Uint8Array(size) });

/** Message events of a span as sorted `TYPE #id size N` lines, independent of the collector's event order. */
function eventLines(span: NormalizedSpan): string[] {
	return span.events
		.map((e) => {
			assert.strictEqual(e.name, semconv.EVENT_RPC_MESSAGE);
			return `${e.attributes[semconv.ATTR_RPC_MESSAGE_TYPE]} #${e.attributes[semconv.ATTR_RPC_MESSAGE_ID]} size ${e.attributes[semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE]}`;
		})
		.sort();
}

/** The message stream of a streaming response. */
function streamOf(response: unknown): AsyncIterable<unknown> {
	return (response as { message: AsyncIterable<unknown> }).message;
}

/** A handler that reads the whole request stream and records what it read. */
function readingNext(read: unknown[], response: () => unknown): never {
	return (async (req: { stream: boolean; message: AsyncIterable<unknown> }) => {
		if (req.stream) {
			for await (const message of req.message) read.push(message);
		}
		return response();
	}) as never;
}

for (const side of SIDES) {
	describe(`${side.name} streaming`, () => {
		afterEach(async () => {
			await shutdownProvider();
		});

		const durationPoints = (observed: Observed) => pointAttributes(observed, side.durationMetric);

		it("should hand the streamed request messages to the handler unchanged inside one span", async () => {
			const messages = [sized(10), sized(20), sized(30)];
			const read: unknown[] = [];
			const handler = side.create({})(readingNext(read, () => ({ stream: false, message: sized(5) })));

			const observed = await observe(async () => {
				await handler(createMockRequest({ stream: true, message: mockAsyncIterable(messages) as any }));
			});

			assert.strictEqual(read.length, 3);
			messages.forEach((message, i) => {
				assert.strictEqual(read[i], message);
			});
			const span = onlySpan(observed);
			assert.strictEqual(span.kind, side.spanKind);
			assert.deepStrictEqual(span.events, [], "message events are opt-in");
			assert.deepStrictEqual(histogramTotals(observed, side.requestSizeMetric), { sum: 0, count: 1 });
		});

		it(`should record ${side.requestDirection} events for the streamed request messages with recordMessages=true`, async () => {
			const read: unknown[] = [];
			const handler = side.create({ recordMessages: true })(readingNext(read, () => ({ stream: false, message: sized(5) })));

			const observed = await observe(async () => {
				await handler(createMockRequest({ stream: true, message: mockAsyncIterable([sized(10), sized(20)]) as any }));
			});

			assert.deepStrictEqual(eventLines(onlySpan(observed)), [
				`${side.requestDirection} #1 size 10`,
				`${side.requestDirection} #2 size 20`,
				`${side.responseDirection} #1 size 5`,
			].sort());
		});

		it("should hand the streamed response messages to the caller unchanged and end the span when they are drained", async () => {
			const responses = [sized(15), sized(25)];
			const next: any = async () => ({ stream: true, message: mockAsyncIterable(responses) });
			const handler = side.create({})(next);
			let collected: unknown[] = [];

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
				assert.strictEqual(response.stream, true);
				collected = await collectAll(response.message);
			});

			assert.strictEqual(collected.length, 2);
			assert.strictEqual(collected[0], responses[0]);
			assert.strictEqual(collected[1], responses[1]);
			const span = onlySpan(observed);
			assert.strictEqual(span.kind, side.spanKind);
			assert.deepStrictEqual(span.events, [], "message events are opt-in");
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in span.attributes), "a started stream has no final status yet");
			assert.deepStrictEqual(histogramTotals(observed, side.responseSizeMetric), { sum: 0, count: 1 });
		});

		it(`should record ${side.responseDirection} events for the streamed response messages with recordMessages=true`, async () => {
			const next: any = async () => ({ stream: true, message: mockAsyncIterable([sized(15), sized(25), sized(35)]) });
			const handler = side.create({ recordMessages: true })(next);

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
				await collectAll(streamOf(response));
			});

			assert.deepStrictEqual(eventLines(onlySpan(observed)), [
				`${side.requestDirection} #1 size 42`,
				`${side.responseDirection} #1 size 15`,
				`${side.responseDirection} #2 size 25`,
				`${side.responseDirection} #3 size 35`,
			].sort());
		});

		it("should record both directions of a bidirectional stream in one span", async () => {
			const responses = [sized(30), sized(40)];
			const read: unknown[] = [];
			const handler = side.create({ recordMessages: true })(readingNext(read, () => ({ stream: true, message: mockAsyncIterable(responses) })));
			let collected: unknown[] = [];

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: true, message: mockAsyncIterable([sized(10), sized(20)]) as any }));
				collected = await collectAll(streamOf(response));
			});

			assert.strictEqual(collected[0], responses[0]);
			assert.strictEqual(collected[1], responses[1]);
			assert.deepStrictEqual(eventLines(onlySpan(observed)), [
				`${side.requestDirection} #1 size 10`,
				`${side.requestDirection} #2 size 20`,
				`${side.responseDirection} #1 size 30`,
				`${side.responseDirection} #2 size 40`,
			].sort());
		});

		// Oracle: the span status rules of the OpenTelemetry trace API and the package
		// guide: a stream that raises an error ends its span with status ERROR carrying the
		// error message and records the exception; the error still reaches the consumer.
		it("should end the span with status ERROR and the recorded exception when the streamed response fails", async () => {
			const failure = new Error("stream failed");
			const next: any = async () => ({ stream: true, message: mockAsyncIterableWithError([sized(15)], failure) });
			const handler = side.create({})(next);
			const received: unknown[] = [];

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
				await assert.rejects(async () => {
					for await (const message of streamOf(response)) received.push(message);
				}, failure);
			});

			assert.strictEqual(received.length, 1, "the message before the failure is delivered");
			const span = onlySpan(observed);
			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
			assert.strictEqual(span.status.message, "stream failed");
			const exceptions = span.events.filter((e) => e.name === "exception");
			assert.strictEqual(exceptions.length, 1);
			assert.strictEqual(exceptions[0]?.attributes["exception.message"], "stream failed");
		});

		// Oracle: the same rules: a consumer that stops reading is not a failure, so the
		// span still ends, exactly once, with its status unset and no exception.
		it("should end the span with its status unset and no exception when the consumer stops reading early", async () => {
			async function* endless() {
				for (let i = 0; ; i++) yield sized(i + 1);
			}
			const next: any = async () => ({ stream: true, message: endless() });
			const handler = side.create({})(next);

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
				for await (const _message of streamOf(response)) break;
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
			assert.deepStrictEqual(span.events, []);
		});

		// Oracle: the OpenTelemetry RPC metrics conventions: when the duration metric is
		// reported alongside an RPC span, its value SHOULD be the duration of that span, and
		// the span of a stream lasts until the stream ends. A stream of three messages 40 ms
		// apart lasts at least 120 ms; the bound 100 ms only needs to tell that from the
		// time to the response head (a few ms), so it survives a loaded machine.
		const STREAM_STEP_MS = 40;
		async function* slowMessages(count: number, failureAfter?: { messages: number; error: unknown }) {
			for (let i = 0; i < count; i++) {
				await delay(STREAM_STEP_MS);
				if (failureAfter && i === failureAfter.messages) throw failureAfter.error;
				yield sized(i + 1);
			}
		}

		for (const withoutTracing of [false, true]) {
			it(`should record the duration of a stream when the stream ends, not when the response head returns${withoutTracing ? " (metrics only)" : ""}`, async () => {
				const next: any = async () => ({ stream: true, message: slowMessages(3) });
				const handler = side.create({ withoutTracing })(next);

				const observed = await observe(async () => {
					const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
					await collectAll(streamOf(response));
				});

				const totals = histogramTotals(observed, side.durationMetric);
				assert.strictEqual(totals.count, 1, "exactly one duration point per call");
				assert.ok(totals.sum >= 0.1, `the duration covers the whole stream, got ${totals.sum} s`);
			});

			it(`should record error.type and rpc.response.status_code on the span and the duration metric when a stream fails after it started${withoutTracing ? " (metrics only)" : ""}`, async () => {
				const failure = new ConnectError("backend gone", Code.Unavailable);
				const next: any = async () => ({ stream: true, message: slowMessages(3, { messages: 2, error: failure }) });
				const handler = side.create({ withoutTracing })(next);

				const observed = await observe(async () => {
					const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
					await assert.rejects(() => collectAll(streamOf(response)), failure);
				});

				const totals = histogramTotals(observed, side.durationMetric);
				assert.strictEqual(totals.count, 1, "exactly one duration point per call");
				assert.ok(totals.sum >= 0.08, `the duration covers the stream up to the failure, got ${totals.sum} s`);
				assert.strictEqual(durationPoints(observed).length, 1);
				assert.strictEqual(durationPoints(observed)[0]?.[semconv.ATTR_ERROR_TYPE], "UNAVAILABLE");
				assert.strictEqual(durationPoints(observed)[0]?.[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "UNAVAILABLE");
				if (withoutTracing) {
					assert.deepStrictEqual(observed.spans, []);
				} else {
					const span = onlySpan(observed);
					assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "UNAVAILABLE");
					assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "UNAVAILABLE");
					assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				}
			});

			it(`should record the class name as error.type, and no status code, when a stream fails with a generic error${withoutTracing ? " (metrics only)" : ""}`, async () => {
				const failure = new TypeError("bad message");
				const next: any = async () => ({ stream: true, message: slowMessages(2, { messages: 1, error: failure }) });
				const handler = side.create({ withoutTracing })(next);

				const observed = await observe(async () => {
					const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
					await assert.rejects(() => collectAll(streamOf(response)), failure);
				});

				assert.strictEqual(durationPoints(observed).length, 1);
				assert.strictEqual(durationPoints(observed)[0]?.[semconv.ATTR_ERROR_TYPE], "TypeError");
				assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in (durationPoints(observed)[0] ?? {})));
				if (!withoutTracing) assert.strictEqual(onlySpan(observed).attributes[semconv.ATTR_ERROR_TYPE], "TypeError");
			});

			it(`should record the duration once, without error attributes, when the consumer stops reading early${withoutTracing ? " (metrics only)" : ""}`, async () => {
				const next: any = async () => ({ stream: true, message: slowMessages(10) });
				const handler = side.create({ withoutTracing })(next);

				const observed = await observe(async () => {
					const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
					for await (const _message of streamOf(response)) break;
				});

				assert.strictEqual(durationPoints(observed).length, 1);
				assert.ok(!(semconv.ATTR_ERROR_TYPE in (durationPoints(observed)[0] ?? {})));
				assert.ok(histogramTotals(observed, side.durationMetric).sum >= 0.03, "the duration includes the time until the consumer stopped");
			});
		}

		// Oracle: the Connect RPC conventions: on a client span every status code but OK is an
		// error; on a server span only unknown, deadline_exceeded, unimplemented, internal,
		// unavailable and data_loss are, so a stream that fails with NOT_FOUND leaves a server
		// span unset and marks a client span ERROR. The code is reported either way.
		it("should set the span status of a stream that fails with NOT_FOUND by the side of the call", async () => {
			const failure = new ConnectError("no such user", Code.NotFound);
			const next: any = async () => ({ stream: true, message: slowMessages(2, { messages: 1, error: failure }) });
			const handler = side.create({})(next);

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: false, message: OTEL_REQUEST_MESSAGE }));
				await assert.rejects(() => collectAll(streamOf(response)), failure);
			});

			const span = onlySpan(observed);
			assert.strictEqual(span.status.code, side.spanKind === SpanKind.SERVER ? SpanStatusCode.UNSET : SpanStatusCode.ERROR);
			assert.strictEqual(span.attributes[semconv.ATTR_RPC_RESPONSE_STATUS_CODE], "NOT_FOUND");
			assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "NOT_FOUND");
		});

		it("should pass stream=true to the filter for streaming requests", async () => {
			let receivedStream: boolean | undefined;
			const interceptor = side.create({
				filter: ((ctx: { stream: boolean }) => {
					receivedStream = ctx.stream;
					return true;
				}) as never,
			});
			const next: any = async (_req: any) => ({ stream: true, message: mockAsyncIterable([]) });

			await interceptor(next)(createMockRequest({ stream: true, message: mockAsyncIterable([]) as any }));

			assert.strictEqual(receivedStream, true);
		});

		it("should pass a stream through untouched and record nothing when tracing and metrics are both disabled", async () => {
			const expectedResponse = { stream: true, message: mockAsyncIterable([sized(5)]) };
			const handler = side.create({ withoutTracing: true, withoutMetrics: true })((async () => expectedResponse) as never);
			let response: unknown;

			const observed = await observe(async () => {
				response = await handler(createMockRequest({ stream: true, message: mockAsyncIterable([]) as any }));
				await collectAll(expectedResponse.message);
			});

			assert.strictEqual(response, expectedResponse);
			assert.deepStrictEqual(observed.spans, []);
			assert.deepStrictEqual(observed.metrics, []);
		});

		it("should record only the duration metric of a stream, without a status code, with withoutTracing=true", async () => {
			const responses = [sized(10)];
			const next: any = async () => ({ stream: true, message: mockAsyncIterable(responses) });
			const handler = side.create({ withoutTracing: true })(next);
			let collected: unknown[] = [];

			const observed = await observe(async () => {
				const response = await handler(createMockRequest({ stream: true, message: mockAsyncIterable([]) as any }));
				collected = await collectAll(streamOf(response));
			});

			assert.strictEqual(collected[0], responses[0]);
			assert.deepStrictEqual(observed.spans, []);
			assert.strictEqual(durationPoints(observed).length, 1);
			assert.ok(!(semconv.ATTR_RPC_RESPONSE_STATUS_CODE in (durationPoints(observed)[0] ?? {})));
		});
	});
}
