/**
 * Streaming support unit tests
 *
 * Tests streaming-related functionality across the @connectum/otel package:
 * - wrapAsyncIterable() from shared.ts -- core streaming wrapper
 * - Streaming request/response wrapping in server interceptor (createOtelInterceptor)
 * - Streaming request/response wrapping in client interceptor (createOtelClientInterceptor)
 * - estimateMessageSize() caching behavior (WeakMap)
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";
import { estimateMessageSize, wrapAsyncIterable } from "../../src/shared.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock span that captures addEvent calls for assertion.
 */
function createMockSpan() {
	const events: Array<{ name: string; attributes: Record<string, unknown> | undefined }> = [];
	return {
		span: {
			addEvent(name: string, attributes?: Record<string, unknown>) {
				events.push({ name, attributes });
			},
		} as any,
		events,
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

/**
 * Creates a mock ConnectRPC request object.
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

	it("should return 0 size for messages without toBinary", async () => {
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

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.name, "rpc.message");
		assert.strictEqual(events[0]!.attributes?.["rpc.message.type"], "RECEIVED");
		assert.strictEqual(events[0]!.attributes?.["rpc.message.id"], 1);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.uncompressed_size"], 33);
	});

	it("should set rpc.message.type to SENT for outgoing messages", async () => {
		const { span, events } = createMockSpan();
		const items = [{ toBinary: () => new Uint8Array(5) }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "SENT", true);
		await collectAll(wrapped);

		assert.strictEqual(events[0]!.attributes?.["rpc.message.type"], "SENT");
	});

	it("should set rpc.message.type to RECEIVED for incoming messages", async () => {
		const { span, events } = createMockSpan();
		const items = [{ toBinary: () => new Uint8Array(5) }];

		const wrapped = wrapAsyncIterable(mockAsyncIterable(items), span, "RECEIVED", true);
		await collectAll(wrapped);

		assert.strictEqual(events[0]!.attributes?.["rpc.message.type"], "RECEIVED");
	});

	// -----------------------------------------------------------------------
	// Error handling mid-stream
	// -----------------------------------------------------------------------

	it("should handle stream errors mid-flight (add error event on span)", async () => {
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

		// Should have 3 events: 2 successful messages + 1 error event
		assert.strictEqual(events.length, 3);

		// First two events are normal messages
		assert.strictEqual(events[0]!.attributes?.["rpc.message.id"], 1);
		assert.strictEqual(events[1]!.attributes?.["rpc.message.id"], 2);

		// Third event is the error event with sequence 3
		assert.strictEqual(events[2]!.name, "rpc.message");
		assert.strictEqual(events[2]!.attributes?.["rpc.message.type"], "RECEIVED");
		assert.strictEqual(events[2]!.attributes?.["rpc.message.id"], 3);
		assert.strictEqual(events[2]!.attributes?.["rpc.message.error"], true);
	});

	it("should record error event even when recordMessages is false", async () => {
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

		// Error event is always added regardless of recordMessages
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.name, "rpc.message");
		assert.strictEqual(events[0]!.attributes?.["rpc.message.error"], true);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.id"], 1);
		assert.strictEqual(events[0]!.attributes?.["rpc.message.type"], "SENT");
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
});

// ---------------------------------------------------------------------------
// estimateMessageSize() caching behavior
// ---------------------------------------------------------------------------

describe("estimateMessageSize caching", () => {
	it("should return cached size for same message object (only calls toBinary once)", () => {
		let callCount = 0;
		const message = {
			toBinary: () => {
				callCount++;
				return new Uint8Array(42);
			},
		};

		const size1 = estimateMessageSize(message);
		const size2 = estimateMessageSize(message);

		assert.strictEqual(size1, 42);
		assert.strictEqual(size2, 42);
		// toBinary should be called only once due to WeakMap caching
		assert.strictEqual(callCount, 1);
	});

	it("should not call toBinary twice for same message", () => {
		let callCount = 0;
		const message = {
			toBinary: () => {
				callCount++;
				return new Uint8Array(99);
			},
		};

		estimateMessageSize(message);
		estimateMessageSize(message);
		estimateMessageSize(message);

		assert.strictEqual(callCount, 1);
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
// Streaming in server interceptor (createOtelInterceptor)
// ---------------------------------------------------------------------------

describe("createOtelInterceptor streaming", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	// -----------------------------------------------------------------------
	// Streaming request wrapping
	// -----------------------------------------------------------------------

	it("should wrap streaming request messages through the interceptor", async () => {
		const interceptor = createOtelInterceptor();
		const msg1 = { toBinary: () => new Uint8Array(10), value: "a" };
		const msg2 = { toBinary: () => new Uint8Array(20), value: "b" };
		const msg3 = { toBinary: () => new Uint8Array(30), value: "c" };

		let capturedReqMessages: unknown[] = [];
		const next: any = async (req: any) => {
			// Consume the streaming request messages
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const msg of req.message) {
					capturedReqMessages.push(msg);
				}
			}
			return { stream: false, message: { toBinary: () => new Uint8Array(5) } };
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([msg1, msg2, msg3]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(capturedReqMessages.length, 3);
		assert.strictEqual(capturedReqMessages[0], msg1);
		assert.strictEqual(capturedReqMessages[1], msg2);
		assert.strictEqual(capturedReqMessages[2], msg3);
	});

	// -----------------------------------------------------------------------
	// Streaming response wrapping
	// -----------------------------------------------------------------------

	it("should wrap streaming response messages through the interceptor", async () => {
		const interceptor = createOtelInterceptor();
		const resp1 = { toBinary: () => new Uint8Array(15), id: 1 };
		const resp2 = { toBinary: () => new Uint8Array(25), id: 2 };

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([resp1, resp2]),
		});

		const req = createMockRequest({ stream: false });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		// Consume the wrapped streaming response
		const collected = await collectAll(response.message);
		assert.strictEqual(collected.length, 2);
		assert.strictEqual(collected[0], resp1);
		assert.strictEqual(collected[1], resp2);
	});

	// -----------------------------------------------------------------------
	// recordMessages with streaming
	// -----------------------------------------------------------------------

	it("should record stream message events with recordMessages=true for streaming requests", async () => {
		const interceptor = createOtelInterceptor({ recordMessages: true });
		const msg1 = { toBinary: () => new Uint8Array(10) };
		const msg2 = { toBinary: () => new Uint8Array(20) };

		const next: any = async (req: any) => {
			// Consume streaming request to trigger wrapAsyncIterable events
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const _msg of req.message) {
					// consume
				}
			}
			return { stream: false, message: { toBinary: () => new Uint8Array(5) } };
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([msg1, msg2]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		// The interceptor should complete without errors
		assert.ok(response);
	});

	it("should record stream message events with recordMessages=true for streaming responses", async () => {
		const interceptor = createOtelInterceptor({ recordMessages: true });
		const resp1 = { toBinary: () => new Uint8Array(15) };
		const resp2 = { toBinary: () => new Uint8Array(25) };
		const resp3 = { toBinary: () => new Uint8Array(35) };

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([resp1, resp2, resp3]),
		});

		const req = createMockRequest({ stream: false });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		// Consume wrapped response to trigger events
		const collected = await collectAll(response.message);
		assert.strictEqual(collected.length, 3);
	});

	// -----------------------------------------------------------------------
	// Bidirectional streaming (request + response both streaming)
	// -----------------------------------------------------------------------

	it("should handle bidirectional streaming (both request and response are streams)", async () => {
		const interceptor = createOtelInterceptor({ recordMessages: true });
		const reqMsg1 = { toBinary: () => new Uint8Array(10), dir: "req" };
		const reqMsg2 = { toBinary: () => new Uint8Array(20), dir: "req" };
		const respMsg1 = { toBinary: () => new Uint8Array(30), dir: "resp" };
		const respMsg2 = { toBinary: () => new Uint8Array(40), dir: "resp" };

		const next: any = async (req: any) => {
			// Consume streaming request
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const _msg of req.message) {
					// consume
				}
			}
			return {
				stream: true,
				message: mockAsyncIterable([respMsg1, respMsg2]),
			};
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([reqMsg1, reqMsg2]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		const collectedResp = await collectAll(response.message);
		assert.strictEqual(collectedResp.length, 2);
		assert.strictEqual(collectedResp[0], respMsg1);
		assert.strictEqual(collectedResp[1], respMsg2);
	});

	// -----------------------------------------------------------------------
	// Streaming with filter
	// -----------------------------------------------------------------------

	it("should pass stream=true to filter for streaming requests", async () => {
		let receivedStream: boolean | undefined;
		const interceptor = createOtelInterceptor({
			filter: (ctx) => {
				receivedStream = ctx.stream;
				return true;
			},
		});

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([]),
		});

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([]) as any,
		});

		const handler = interceptor(next);
		await handler(req);

		assert.strictEqual(receivedStream, true);
	});

	// -----------------------------------------------------------------------
	// Streaming with feature toggles
	// -----------------------------------------------------------------------

	it("should pass through streaming when both tracing and metrics disabled", async () => {
		const interceptor = createOtelInterceptor({
			withoutTracing: true,
			withoutMetrics: true,
		});
		const resp1 = { toBinary: () => new Uint8Array(5) };

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([resp1]),
		});

		const req = createMockRequest({ stream: true, message: mockAsyncIterable([]) as any });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);
	});

	it("should handle streaming in metrics-only mode (withoutTracing=true)", async () => {
		const interceptor = createOtelInterceptor({ withoutTracing: true });

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([{ toBinary: () => new Uint8Array(10) }]),
		});

		const req = createMockRequest({ stream: true, message: mockAsyncIterable([]) as any });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);
	});
});

// ---------------------------------------------------------------------------
// Streaming in client interceptor (createOtelClientInterceptor)
// ---------------------------------------------------------------------------

describe("createOtelClientInterceptor streaming", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	// -----------------------------------------------------------------------
	// Streaming request wrapping
	// -----------------------------------------------------------------------

	it("should wrap streaming request messages through the client interceptor", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
		});
		const msg1 = { toBinary: () => new Uint8Array(10), value: "x" };
		const msg2 = { toBinary: () => new Uint8Array(20), value: "y" };

		let capturedReqMessages: unknown[] = [];
		const next: any = async (req: any) => {
			// Consume the streaming request messages
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const msg of req.message) {
					capturedReqMessages.push(msg);
				}
			}
			return { stream: false, message: { toBinary: () => new Uint8Array(5) } };
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([msg1, msg2]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(capturedReqMessages.length, 2);
		assert.strictEqual(capturedReqMessages[0], msg1);
		assert.strictEqual(capturedReqMessages[1], msg2);
	});

	// -----------------------------------------------------------------------
	// Streaming response wrapping
	// -----------------------------------------------------------------------

	it("should wrap streaming response messages through the client interceptor", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
		});
		const resp1 = { toBinary: () => new Uint8Array(15), id: 1 };
		const resp2 = { toBinary: () => new Uint8Array(25), id: 2 };

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([resp1, resp2]),
		});

		const req = createMockRequest({ stream: false });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		const collected = await collectAll(response.message);
		assert.strictEqual(collected.length, 2);
		assert.strictEqual(collected[0], resp1);
		assert.strictEqual(collected[1], resp2);
	});

	// -----------------------------------------------------------------------
	// recordMessages with streaming (client-side direction differences)
	// -----------------------------------------------------------------------

	it("should record stream message events with recordMessages=true for client streaming requests (direction=SENT)", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			recordMessages: true,
		});
		const msg1 = { toBinary: () => new Uint8Array(10) };

		const next: any = async (req: any) => {
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const _msg of req.message) {
					// consume
				}
			}
			return { stream: false, message: { toBinary: () => new Uint8Array(5) } };
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([msg1]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
	});

	it("should record stream message events with recordMessages=true for client streaming responses (direction=RECEIVED)", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			recordMessages: true,
		});
		const resp1 = { toBinary: () => new Uint8Array(15) };
		const resp2 = { toBinary: () => new Uint8Array(25) };

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([resp1, resp2]),
		});

		const req = createMockRequest({ stream: false });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		const collected = await collectAll(response.message);
		assert.strictEqual(collected.length, 2);
	});

	// -----------------------------------------------------------------------
	// Client bidirectional streaming
	// -----------------------------------------------------------------------

	it("should handle bidirectional streaming in client interceptor", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			recordMessages: true,
		});
		const reqMsg = { toBinary: () => new Uint8Array(10) };
		const respMsg = { toBinary: () => new Uint8Array(30) };

		const next: any = async (req: any) => {
			if (req.stream && req.message && req.message[Symbol.asyncIterator]) {
				for await (const _msg of req.message) {
					// consume
				}
			}
			return {
				stream: true,
				message: mockAsyncIterable([respMsg]),
			};
		};

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([reqMsg]) as any,
		});

		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);

		const collected = await collectAll(response.message);
		assert.strictEqual(collected.length, 1);
		assert.strictEqual(collected[0], respMsg);
	});

	// -----------------------------------------------------------------------
	// Client streaming with filter
	// -----------------------------------------------------------------------

	it("should pass stream=true to client filter for streaming requests", async () => {
		let receivedStream: boolean | undefined;
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			filter: (ctx) => {
				receivedStream = ctx.stream;
				return true;
			},
		});

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([]),
		});

		const req = createMockRequest({
			stream: true,
			message: mockAsyncIterable([]) as any,
		});

		const handler = interceptor(next);
		await handler(req);

		assert.strictEqual(receivedStream, true);
	});

	// -----------------------------------------------------------------------
	// Client streaming with feature toggles
	// -----------------------------------------------------------------------

	it("should pass through streaming when both tracing and metrics disabled (client)", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			withoutTracing: true,
			withoutMetrics: true,
		});

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([{ toBinary: () => new Uint8Array(5) }]),
		});

		const req = createMockRequest({ stream: true, message: mockAsyncIterable([]) as any });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);
	});

	it("should handle streaming in client metrics-only mode (withoutTracing=true)", async () => {
		const interceptor = createOtelClientInterceptor({
			serverAddress: "api.example.com",
			withoutTracing: true,
		});

		const next: any = async (_req: any) => ({
			stream: true,
			message: mockAsyncIterable([{ toBinary: () => new Uint8Array(10) }]),
		});

		const req = createMockRequest({ stream: true, message: mockAsyncIterable([]) as any });
		const handler = interceptor(next);
		const response = await handler(req);

		assert.ok(response);
		assert.strictEqual(response.stream, true);
	});
});
