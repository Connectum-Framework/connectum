/**
 * OTLP/gRPC exporters deliver telemetry to a gRPC collector.
 *
 * The collector is a real HTTP/2 server speaking the gRPC wire protocol (length-prefixed
 * messages, `grpc-status` trailer) on a loopback port, so the exporters under test are the
 * real gRPC clients of the OpenTelemetry SDK. Its requests are decoded by a small protobuf
 * reader driven by the field numbers of the published OTLP collector protos, so what the
 * collector received is compared with what the test emitted, not with what the exporter
 * serialiser says it sent.
 *
 * OTLP/gRPC service paths and field numbers come from opentelemetry-proto:
 * - `opentelemetry.proto.collector.{trace,metrics,logs}.v1.{Trace,Metrics,Logs}Service/Export`
 * - `Export*ServiceRequest.resource_{spans,metrics,logs} = 1`, `Resource.attributes = 1`,
 *   `KeyValue { key = 1, value = 2 }`, `AnyValue.string_value = 1`
 * - spans: `ResourceSpans.scope_spans = 2`, `ScopeSpans.spans = 2`, `Span { trace_id = 1, name = 5 }`
 * - metrics: `ResourceMetrics.scope_metrics = 2`, `ScopeMetrics.metrics = 2`,
 *   `Metric { name = 1, sum = 7 }`, `Sum.data_points = 1`, `NumberDataPoint { as_double = 4, as_int = 6 }`
 * - logs: `ResourceLogs.scope_logs = 2`, `ScopeLogs.log_records = 2`, `LogRecord.body = 5`
 */

import assert from "node:assert";
import { createServer, type Http2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_SERVICE_NAME",
] as const;

const SERVICE_NAME = "grpc-collector-probe";

/** One decoded protobuf field: a varint or fixed-width value, or the bytes of a length-delimited one. */
interface Field {
	number: number;
	wireType: number;
	value: bigint | Buffer;
}

function readFields(message: Buffer): Field[] {
	const fields: Field[] = [];
	let offset = 0;
	const varint = (): bigint => {
		let result = 0n;
		let shift = 0n;
		for (;;) {
			const byte = message[offset++];
			assert.ok(byte !== undefined, "truncated varint");
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return result;
			shift += 7n;
		}
	};
	while (offset < message.length) {
		const tag = Number(varint());
		const number = tag >>> 3;
		const wireType = tag & 7;
		if (wireType === 0) {
			fields.push({ number, wireType, value: varint() });
		} else if (wireType === 1) {
			fields.push({ number, wireType, value: message.subarray(offset, offset + 8) });
			offset += 8;
		} else if (wireType === 2) {
			const length = Number(varint());
			fields.push({ number, wireType, value: message.subarray(offset, offset + length) });
			offset += length;
		} else if (wireType === 5) {
			fields.push({ number, wireType, value: message.subarray(offset, offset + 4) });
			offset += 4;
		} else {
			assert.fail(`unsupported protobuf wire type ${wireType}`);
		}
	}
	return fields;
}

/** The length-delimited sub-messages stored in field `number`. */
function children(message: Buffer, number: number): Buffer[] {
	return readFields(message)
		.filter((field) => field.number === number && field.wireType === 2)
		.map((field) => field.value as Buffer);
}

/** The single length-delimited sub-message in field `number`. */
function child(message: Buffer, number: number): Buffer {
	const found = children(message, number);
	assert.strictEqual(found.length, 1, `exactly one field ${number} expected, got ${found.length}`);
	return found[0] as Buffer;
}

/** `Resource.attributes` as a key to string-value map. */
function resourceAttributes(resource: Buffer): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const keyValue of children(resource, 1)) {
		const key = child(keyValue, 1).toString("utf8");
		const [stringValue] = children(child(keyValue, 2), 1);
		if (stringValue !== undefined) attributes.set(key, stringValue.toString("utf8"));
	}
	return attributes;
}

interface GrpcCall {
	path: string;
	contentType: string | undefined;
	/** The protobuf request message with the 5-byte gRPC frame header removed. */
	message: Buffer;
}

interface Collector {
	server: Http2Server;
	endpoint: string;
	calls: GrpcCall[];
	sessions: Set<ServerHttp2Session>;
}

/** A gRPC server that accepts every unary call, records it and answers with an empty response and `grpc-status: 0`. */
async function startCollector(): Promise<Collector> {
	const calls: GrpcCall[] = [];
	const server = createServer();
	const sessions = new Set<ServerHttp2Session>();
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: ServerHttp2Stream, headers) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => {
			const body = Buffer.concat(chunks);
			assert.strictEqual(body[0], 0, "the exporters under test send uncompressed messages");
			const length = body.readUInt32BE(1);
			assert.strictEqual(body.length, 5 + length, "a unary call is exactly one complete gRPC message: no truncated frame, no trailing bytes");
			calls.push({ path: String(headers[":path"]), contentType: String(headers["content-type"]), message: body.subarray(5, 5 + length) });
			stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
			// An Export*ServiceResponse with no partial_success: a zero-length message.
			stream.end(Buffer.from([0, 0, 0, 0, 0]));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, endpoint: `http://127.0.0.1:${port}`, calls, sessions };
}

async function stopCollector(collector: Collector): Promise<void> {
	// The exporter keeps its HTTP/2 session open between exports; close() waits for it.
	await new Promise<void>((resolve) => {
		collector.server.close(() => resolve());
		for (const session of collector.sessions) session.destroy();
	});
}

describe("provider: OTLP/gRPC exporters", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector;

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		collector = await startCollector();
		process.env.OTEL_SERVICE_NAME = SERVICE_NAME;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint;
	});

	afterEach(async () => {
		// Every step runs even when an earlier one rejects: a leaked collector or environment would leak into the next test.
		try {
			await shutdownProvider();
		} finally {
			// The global registrations survive shutdownProvider() and refuse a second
			// registration, so a later test would otherwise record into a dead provider.
			context.disable();
			propagation.disable();
			trace.disable();
			metrics.disable();
			logs.disable();
			try {
				await stopCollector(collector);
			} finally {
				for (const key of ENV_KEYS) {
					const value = saved.get(key);
					if (value === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = value;
					}
				}
			}
		}
	});

	function selectOnly(signal: "traces" | "metrics" | "logs", how: "protocol-variable" | "explicit-exporter"): void {
		for (const s of ["traces", "metrics", "logs"] as const) {
			const variable = `OTEL_${s.toUpperCase()}_EXPORTER`;
			if (s !== signal) {
				process.env[variable] = "none";
			} else if (how === "protocol-variable") {
				// The standard spelling: the bare `otlp` exporter takes its transport from the protocol variable.
				process.env[variable] = "otlp";
				process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
			} else {
				process.env[variable] = "otlp/grpc";
			}
		}
	}

	for (const how of ["protocol-variable", "explicit-exporter"] as const) {
		const label = how === "protocol-variable" ? "OTEL_EXPORTER_OTLP_PROTOCOL=grpc" : "OTEL_*_EXPORTER=otlp/grpc";

		it(`delivers a span to the gRPC trace service for ${label}`, async () => {
			selectOnly("traces", how);

			const span = getProvider().tracer.startSpan("grpc-probe-span");
			const traceId = span.spanContext().traceId;
			span.end();
			await shutdownProvider();

			assert.deepStrictEqual(
				collector.calls.map((call) => [call.path, call.contentType]),
				[["/opentelemetry.proto.collector.trace.v1.TraceService/Export", "application/grpc"]],
			);
			const [resourceSpans] = children(collector.calls[0]?.message as Buffer, 1);
			assert.ok(resourceSpans, "the request carries one ResourceSpans");
			assert.strictEqual(resourceAttributes(child(resourceSpans, 1)).get("service.name"), SERVICE_NAME);
			const [scopeSpans] = children(resourceSpans, 2);
			const spans = children(scopeSpans as Buffer, 2);
			assert.strictEqual(spans.length, 1);
			assert.strictEqual(child(spans[0] as Buffer, 5).toString("utf8"), "grpc-probe-span");
			assert.strictEqual(child(spans[0] as Buffer, 1).toString("hex"), traceId, "the received trace id is the one of the emitted span");
		});

		it(`delivers a metric to the gRPC metrics service for ${label}`, async () => {
			selectOnly("metrics", how);

			getProvider().meter.createCounter("grpc_probe_total").add(3);
			await shutdownProvider();

			assert.deepStrictEqual(
				collector.calls.map((call) => [call.path, call.contentType]),
				[["/opentelemetry.proto.collector.metrics.v1.MetricsService/Export", "application/grpc"]],
			);
			const [resourceMetrics] = children(collector.calls[0]?.message as Buffer, 1);
			assert.ok(resourceMetrics, "the request carries one ResourceMetrics");
			assert.strictEqual(resourceAttributes(child(resourceMetrics, 1)).get("service.name"), SERVICE_NAME);
			const [scopeMetrics] = children(resourceMetrics, 2);
			const received = children(scopeMetrics as Buffer, 2).find((metric) => child(metric, 1).toString("utf8") === "grpc_probe_total");
			assert.ok(received, "the counter that was incremented is in the request");
			// Sum.data_points: a counter increment of 3 is one point with that value, as double (field 4) or as int (field 6).
			const [point] = children(child(received, 7), 1);
			const value = readFields(point as Buffer).find((field) => field.number === 4 || field.number === 6);
			assert.ok(value, "the data point carries a value");
			const observed = value.number === 4 ? (value.value as Buffer).readDoubleLE(0) : (value.value as Buffer).readBigInt64LE(0);
			assert.strictEqual(Number(observed), 3);
		});

		it(`delivers a log record to the gRPC logs service for ${label}`, async () => {
			selectOnly("logs", how);

			getProvider().logger.emit({ body: "grpc-probe-log" });
			await shutdownProvider();

			assert.deepStrictEqual(
				collector.calls.map((call) => [call.path, call.contentType]),
				[["/opentelemetry.proto.collector.logs.v1.LogsService/Export", "application/grpc"]],
			);
			const [resourceLogs] = children(collector.calls[0]?.message as Buffer, 1);
			assert.ok(resourceLogs, "the request carries one ResourceLogs");
			assert.strictEqual(resourceAttributes(child(resourceLogs, 1)).get("service.name"), SERVICE_NAME);
			const [scopeLogs] = children(resourceLogs, 2);
			const records = children(scopeLogs as Buffer, 2);
			assert.strictEqual(records.length, 1);
			assert.strictEqual(child(child(records[0] as Buffer, 5), 1).toString("utf8"), "grpc-probe-log");
		});
	}
});
