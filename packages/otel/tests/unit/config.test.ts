/**
 * Config module tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ExporterType,
	getBatchSpanProcessorOptions,
	getCollectorOptions,
	getOTLPSettings,
	getServiceMetadata,
} from "../../src/config.ts";

describe("config", () => {
	describe("ExporterType", () => {
		it("should have correct values", () => {
			assert.strictEqual(ExporterType.CONSOLE, "console");
			assert.strictEqual(ExporterType.OTLP_HTTP, "otlp/http");
			assert.strictEqual(ExporterType.OTLP_GRPC, "otlp/grpc");
			assert.strictEqual(ExporterType.NONE, "none");
		});
	});

	describe("getOTLPSettings", () => {
		it("should return OTLP settings from environment", () => {
			const settings = getOTLPSettings();

			assert.ok(settings);
			assert.ok("traces" in settings);
			assert.ok("metrics" in settings);
			assert.ok("logs" in settings);
		});

		it("should read from OTEL_TRACES_EXPORTER env var", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp/http";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.traces, "otlp/http");
		});

		it("should read from OTEL_METRICS_EXPORTER env var", () => {
			process.env.OTEL_METRICS_EXPORTER = "otlp/grpc";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.metrics, "otlp/grpc");
		});

		it("should read from OTEL_LOGS_EXPORTER env var", () => {
			process.env.OTEL_LOGS_EXPORTER = "console";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.logs, "console");
		});
	});

	describe("getCollectorOptions", () => {
		it("should return collector options", () => {
			const options = getCollectorOptions();

			assert.ok(options);
			assert.strictEqual(options.concurrencyLimit, 10);
		});

		it("should remove trailing slash from URL", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/";

			const options = getCollectorOptions();

			assert.strictEqual(options.url, "http://localhost:4318");
		});

		it("should handle URL without trailing slash", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

			const options = getCollectorOptions();

			assert.strictEqual(options.url, "http://localhost:4318");
		});
	});

	describe("getBatchSpanProcessorOptions", () => {
		it("should return default options", () => {
			const options = getBatchSpanProcessorOptions();

			assert.strictEqual(options.maxExportBatchSize, 100);
			assert.strictEqual(options.maxQueueSize, 1000);
			assert.strictEqual(options.scheduledDelayMillis, 1000);
			assert.strictEqual(options.exportTimeoutMillis, 10000);
		});

		it("should use custom values from environment", () => {
			process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = "50";
			process.env.OTEL_BSP_MAX_QUEUE_SIZE = "500";
			process.env.OTEL_BSP_SCHEDULE_DELAY = "2000";
			process.env.OTEL_BSP_EXPORT_TIMEOUT = "5000";

			const options = getBatchSpanProcessorOptions();

			assert.strictEqual(options.maxExportBatchSize, 50);
			assert.strictEqual(options.maxQueueSize, 500);
			assert.strictEqual(options.scheduledDelayMillis, 2000);
			assert.strictEqual(options.exportTimeoutMillis, 5000);
		});
	});

	describe("getServiceMetadata", () => {
		it("should return metadata from npm environment", () => {
			delete process.env.OTEL_SERVICE_NAME;
			process.env.npm_package_name = "test-service";
			process.env.npm_package_version = "1.2.3";

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "test-service");
			assert.strictEqual(metadata.version, "1.2.3");
		});

		it("should prioritize OTEL_SERVICE_NAME over npm_package_name", () => {
			process.env.OTEL_SERVICE_NAME = "otel-service";
			process.env.npm_package_name = "npm-service";
			process.env.npm_package_version = "1.0.0";

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "otel-service");
			assert.strictEqual(metadata.version, "1.0.0");

			delete process.env.OTEL_SERVICE_NAME;
		});

		it("should return defaults when npm env not available", () => {
			delete process.env.OTEL_SERVICE_NAME;
			delete process.env.npm_package_name;
			delete process.env.npm_package_version;

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "unknown-service");
			assert.strictEqual(metadata.version, "0.0.0");
		});

		it("should handle missing name only", () => {
			delete process.env.OTEL_SERVICE_NAME;
			delete process.env.npm_package_name;
			process.env.npm_package_version = "2.0.0";

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "unknown-service");
			assert.strictEqual(metadata.version, "2.0.0");
		});

		it("should handle missing version only", () => {
			delete process.env.OTEL_SERVICE_NAME;
			process.env.npm_package_name = "my-service";
			delete process.env.npm_package_version;

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "my-service");
			assert.strictEqual(metadata.version, "0.0.0");
		});
	});
});
