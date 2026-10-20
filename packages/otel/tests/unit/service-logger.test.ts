process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { LogRecord } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { getLogger } from "../../src/logger.ts";
import { getProvider, shutdownProvider } from "../../src/provider.ts";

const sdkTracerProvider = new NodeTracerProvider();
sdkTracerProvider.register();
const sdkTracer = sdkTracerProvider.getTracer("test");

function captureEmit(): { calls: LogRecord[]; restore: () => void } {
	const calls: LogRecord[] = [];
	const provider = getProvider();
	const original = provider.logger.emit.bind(provider.logger);
	provider.logger.emit = (record: LogRecord) => {
		calls.push(record);
	};
	return {
		calls,
		restore() {
			provider.logger.emit = original;
		},
	};
}

function firstCall(capture: { calls: LogRecord[] }): LogRecord {
	const record = capture.calls[0];
	assert.ok(record, "Expected at least one emit call");
	return record;
}

describe("getLogger", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	it("should create a logger with all methods", () => {
		const logger = getLogger("TestService");

		assert.ok(typeof logger.info === "function");
		assert.ok(typeof logger.warn === "function");
		assert.ok(typeof logger.error === "function");
		assert.ok(typeof logger.debug === "function");
		assert.ok(typeof logger.emit === "function");
	});

	it("should emit info log with correct severity", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.info("test message");

		assert.strictEqual(capture.calls.length, 1);
		const record = firstCall(capture);
		assert.strictEqual(record.severityNumber, SeverityNumber.INFO);
		assert.strictEqual(record.severityText, "INFO");
		assert.strictEqual(record.body, "test message");
		capture.restore();
	});

	it("should emit warn log with correct severity", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.warn("warning message");

		assert.strictEqual(capture.calls.length, 1);
		const record = firstCall(capture);
		assert.strictEqual(record.severityNumber, SeverityNumber.WARN);
		assert.strictEqual(record.severityText, "WARN");
		assert.strictEqual(record.body, "warning message");
		capture.restore();
	});

	it("should emit error log with correct severity", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.error("error message");

		assert.strictEqual(capture.calls.length, 1);
		const record = firstCall(capture);
		assert.strictEqual(record.severityNumber, SeverityNumber.ERROR);
		assert.strictEqual(record.severityText, "ERROR");
		assert.strictEqual(record.body, "error message");
		capture.restore();
	});

	it("should emit debug log with correct severity", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.debug("debug message");

		assert.strictEqual(capture.calls.length, 1);
		const record = firstCall(capture);
		assert.strictEqual(record.severityNumber, SeverityNumber.DEBUG);
		assert.strictEqual(record.severityText, "DEBUG");
		assert.strictEqual(record.body, "debug message");
		capture.restore();
	});

	it("should include logger.name in attributes", () => {
		const capture = captureEmit();
		const logger = getLogger("OrderService");

		logger.info("test");

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "OrderService");
		capture.restore();
	});

	it("should merge custom attributes with base attributes", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.info("test", { orderId: "123", userId: "456" });

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "TestService");
		assert.strictEqual(attrs.orderId, "123");
		assert.strictEqual(attrs.userId, "456");
		capture.restore();
	});

	it("should include defaultAttributes from options", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService", {
			defaultAttributes: { "service.layer": "domain" },
		});

		logger.info("test");

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "TestService");
		assert.strictEqual(attrs["service.layer"], "domain");
		capture.restore();
	});

	it("should allow call-level attributes to override defaults", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService", {
			defaultAttributes: { env: "staging" },
		});

		logger.info("test", { env: "production" });

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs.env, "production");
		capture.restore();
	});

	it("should emit raw LogRecord via emit()", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.emit({
			severityNumber: SeverityNumber.INFO,
			severityText: "INFO",
			body: "raw record",
			attributes: { custom: true },
		});

		assert.strictEqual(capture.calls.length, 1);
		const record = firstCall(capture);
		assert.strictEqual(record.severityNumber, SeverityNumber.INFO);
		assert.strictEqual(record.body, "raw record");
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs.custom, true);
		capture.restore();
	});

	it("should pass raw LogRecord to OTel logger without merging base attributes", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService", {
			defaultAttributes: { env: "test" },
		});

		const raw: LogRecord = {
			severityNumber: SeverityNumber.WARN,
			severityText: "WARN",
			body: "raw",
			attributes: { only: "this" },
		};
		logger.emit(raw);

		// The documented "Raw OpenTelemetry LogRecord" is handed to the SDK as given:
		// neither the logger name nor the default attributes are added to it.
		assert.strictEqual(capture.calls.length, 1);
		assert.deepStrictEqual(firstCall(capture), {
			severityNumber: SeverityNumber.WARN,
			severityText: "WARN",
			body: "raw",
			attributes: { only: "this" },
		});
		capture.restore();
	});

	it("emits one record per level without an active span, with the log data model severities", () => {
		const capture = captureEmit();
		const logger = getLogger("TestService");

		logger.info("no span context");
		logger.warn("no span context");
		logger.error("no span context");
		logger.debug("no span context");

		// Severity numbers are fixed by the OpenTelemetry log data model: DEBUG 5, INFO 9, WARN 13, ERROR 17.
		assert.deepStrictEqual(
			capture.calls.map((record) => [record.severityNumber, record.severityText, record.body]),
			[
				[9, "INFO", "no span context"],
				[13, "WARN", "no span context"],
				[17, "ERROR", "no span context"],
				[5, "DEBUG", "no span context"],
			],
		);
		capture.restore();
	});

	// No document names the fallback logger name; "unknown" is Connectum's own choice and
	// this pins it so that a record without a name and without a span stays recognisable.
	it("should use 'unknown' when called without name and no active span", () => {
		const capture = captureEmit();
		const logger = getLogger();

		logger.info("test");

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "unknown");
		capture.restore();
	});

	it("should resolve the service name from the active span rpc.method attribute", () => {
		const capture = captureEmit();
		const logger = getLogger();

		sdkTracer.startActiveSpan("test-span", { attributes: { "rpc.method": "order.v1.OrderService/GetOrder" } }, (span) => {
			logger.info("inside span");
			span.end();
		});

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "order.v1.OrderService");
		capture.restore();
	});

	it("should prefer explicit name over active span", () => {
		const capture = captureEmit();
		const logger = getLogger("ExplicitName");

		sdkTracer.startActiveSpan("test-span", { attributes: { "rpc.method": "order.v1.OrderService/GetOrder" } }, (span) => {
			logger.info("inside span");
			span.end();
		});

		const record = firstCall(capture);
		const attrs = record.attributes as Record<string, unknown>;
		assert.strictEqual(attrs["logger.name"], "ExplicitName");
		capture.restore();
	});
});
