/**
 * What the OTLP exporters actually send: the resource of every signal carries the
 * attributes given through the provider options, and a log record written inside a
 * span carries that span's trace context. The payloads are read from a local
 * collector that receives OTLP/JSON, so nothing is inferred from the provider's
 * internals.
 */

import assert from "node:assert";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getLogger } from "../../src/logger.ts";
import { getProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_SERVICE_NAME",
	"OTEL_SERVICE_INSTANCE_ID",
	"OTEL_RESOURCE_ATTRIBUTES",
] as const;

interface OtlpValue {
	stringValue?: string;
	intValue?: number | string;
	boolValue?: boolean;
}

interface OtlpResource {
	attributes?: Array<{ key: string; value: OtlpValue }>;
}

interface LogRecord {
	body?: OtlpValue;
	traceId?: string;
	spanId?: string;
}

interface Payload {
	resourceSpans?: Array<{ resource: OtlpResource }>;
	resourceMetrics?: Array<{ resource: OtlpResource }>;
	resourceLogs?: Array<{ resource: OtlpResource; scopeLogs: Array<{ logRecords: LogRecord[] }> }>;
}

interface Collector {
	server: Server;
	origin: string;
	/** Parsed OTLP/JSON bodies by request path. */
	bodies: Map<string, Payload[]>;
}

async function startCollector(): Promise<Collector> {
	const bodies = new Map<string, Payload[]>();
	const server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const path = req.url ?? "";
			bodies.set(path, [...(bodies.get(path) ?? []), JSON.parse(Buffer.concat(chunks).toString("utf8")) as Payload]);
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, origin: `http://127.0.0.1:${port}`, bodies };
}

async function stopCollector(collector: Collector): Promise<void> {
	collector.server.closeAllConnections();
	await new Promise<void>((resolve) => collector.server.close(() => resolve()));
}

/** Attributes of an OTLP/JSON resource as a plain record. */
function attributesOf(resource: OtlpResource): Record<string, string | number | boolean | undefined> {
	const record: Record<string, string | number | boolean | undefined> = {};
	for (const { key, value } of resource.attributes ?? []) {
		record[key] = value.stringValue ?? (value.intValue === undefined ? value.boolValue : Number(value.intValue));
	}
	return record;
}

describe("provider: exported telemetry content", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector | undefined;

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		collector = await startCollector();
		process.env.OTEL_TRACES_EXPORTER = "otlp/http";
		process.env.OTEL_METRICS_EXPORTER = "otlp/http";
		process.env.OTEL_LOGS_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;
	});

	afterEach(async () => {
		await shutdownProvider();
		// The global registrations survive shutdownProvider() and refuse a second
		// registration, so a later test would otherwise record into a dead provider.
		context.disable();
		propagation.disable();
		trace.disable();
		metrics.disable();
		logs.disable();
		if (collector) {
			await stopCollector(collector);
			collector = undefined;
		}
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	function received(path: string): Payload[] {
		return collector?.bodies.get(path) ?? [];
	}

	// Oracle: the documented ProviderOptions: serviceName and serviceVersion override
	// the defaults, instanceId sets service.instance.id (OpenTelemetry resource
	// semantic conventions), resourceAttributes are extra resource attributes applied to
	// traces, metrics and logs alike. Typed values keep their type.
	const OPTIONS = {
		serviceName: "billing",
		serviceVersion: "4.5.6",
		instanceId: "pod-7",
		resourceAttributes: { "device.id": "abc", replica: 3, primary: true },
	};
	const EXPECTED_RESOURCE = {
		"service.name": "billing",
		"service.version": "4.5.6",
		"service.instance.id": "pod-7",
		"device.id": "abc",
		replica: 3,
		primary: true,
	};

	const signals = [
		{
			signal: "traces",
			path: "/v1/traces",
			emit: () => getProvider().tracer.startSpan("probe").end(),
			resources: (payload: Payload) => (payload.resourceSpans ?? []).map((r) => r.resource),
		},
		{
			signal: "metrics",
			path: "/v1/metrics",
			emit: () => getProvider().meter.createCounter("probe_total").add(1),
			resources: (payload: Payload) => (payload.resourceMetrics ?? []).map((r) => r.resource),
		},
		{
			signal: "logs",
			path: "/v1/logs",
			emit: () => getProvider().logger.emit({ body: "probe" }),
			resources: (payload: Payload) => (payload.resourceLogs ?? []).map((r) => r.resource),
		},
	] as const;

	for (const { signal, path, emit, resources } of signals) {
		it(`should send the service name, version, instance id and extra resource attributes with ${signal}`, async () => {
			initProvider(OPTIONS);
			emit();
			await shutdownProvider();

			const exportedResources = received(path).flatMap(resources);
			assert.strictEqual(exportedResources.length, 1, `one resource is exported for ${signal}`);
			const attributes = attributesOf(exportedResources[0] as OtlpResource);
			assert.deepStrictEqual(
				Object.fromEntries(Object.keys(EXPECTED_RESOURCE).map((key) => [key, attributes[key]])),
				EXPECTED_RESOURCE,
			);
		});
	}

	// Oracle: the observability logging guide: "When an active span exists, the
	// OpenTelemetry SDK automatically includes trace_id and span_id in log records."
	describe("log trace correlation", () => {
		it("should stamp a record written inside a span with that span's trace and span ids", async () => {
			const logger = getLogger("correlation");
			let spanContext: { traceId: string; spanId: string } | undefined;
			getProvider().tracer.startActiveSpan("work", (span) => {
				spanContext = span.spanContext();
				logger.info("inside the span");
				span.end();
			});
			await shutdownProvider();

			assert.ok(spanContext);
			const records = received("/v1/logs").flatMap((p) => p.resourceLogs ?? []).flatMap((r) => r.scopeLogs).flatMap((s) => s.logRecords);
			const inside = records.find((r) => r.body?.stringValue === "inside the span");
			assert.ok(inside, "the record is exported");
			assert.strictEqual(inside.traceId, spanContext.traceId);
			assert.strictEqual(inside.spanId, spanContext.spanId);
		});

		it("should leave a record written outside any span without trace context", async () => {
			const logger = getLogger("correlation");
			logger.info("outside any span");
			await shutdownProvider();

			const records = received("/v1/logs").flatMap((p) => p.resourceLogs ?? []).flatMap((r) => r.scopeLogs).flatMap((s) => s.logRecords);
			const outside = records.find((r) => r.body?.stringValue === "outside any span");
			assert.ok(outside, "the record is exported");
			assert.ok(!outside.traceId, "no trace id without an active span");
			assert.ok(!outside.spanId, "no span id without an active span");
		});
	});
});
