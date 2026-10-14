/**
 * Config module tests
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ExporterType,
	getBatchSpanProcessorOptions,
	getCollectorOptions,
	getOTLPSettings,
	getServiceMetadata,
} from "../../src/config.ts";

// Every variable the functions under test read. Each test starts from a clean
// environment and the original values come back afterwards, so no test depends
// on what an earlier one left behind.
const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
	"OTEL_BSP_MAX_QUEUE_SIZE",
	"OTEL_BSP_SCHEDULE_DELAY",
	"OTEL_BSP_EXPORT_TIMEOUT",
	"OTEL_SERVICE_NAME",
	"npm_package_name",
	"npm_package_version",
] as const;

describe("config", () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	describe("ExporterType", () => {
		// The OpenTelemetry SDK environment-variable specification defines
		// "console" and "none" as values of OTEL_<SIGNAL>_EXPORTER, so these two
		// spellings are fixed by the standard.
		it("should spell the exporter values the OpenTelemetry specification defines", () => {
			assert.strictEqual(ExporterType.CONSOLE, "console");
			assert.strictEqual(ExporterType.NONE, "none");
		});

		// "otlp/http", "otlp/http-protobuf" and "otlp/grpc" are Connectum's own
		// explicit spellings (the standard has only the bare "otlp" plus protocol
		// variables). They are documented in the observability backends guide as
		// the values users put into OTEL_<SIGNAL>_EXPORTER.
		it("should spell the Connectum-specific explicit OTLP exporter values as documented", () => {
			assert.strictEqual(ExporterType.OTLP_HTTP, "otlp/http");
			assert.strictEqual(ExporterType.OTLP_HTTP_PROTOBUF, "otlp/http-protobuf");
			assert.strictEqual(ExporterType.OTLP_GRPC, "otlp/grpc");
		});
	});

	describe("getOTLPSettings", () => {
		// The OpenTelemetry SDK environment-variable specification defines
		// OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER and OTEL_LOGS_EXPORTER as
		// independent per-signal switches, with "console" and "none" among the
		// standard values and a bare "otlp" meaning OTLP over HTTP/protobuf unless
		// a protocol variable says otherwise. Three different values make a
		// swapped or constant result visible: every signal must carry its own.
		it("should give each signal the exporter named by its own variable", () => {
			process.env.OTEL_TRACES_EXPORTER = "console";
			process.env.OTEL_METRICS_EXPORTER = "none";
			process.env.OTEL_LOGS_EXPORTER = "otlp";

			assert.deepStrictEqual(getOTLPSettings(), {
				traces: "console",
				metrics: "none",
				logs: "otlp/http-protobuf",
			});
		});

		// Each signal is checked against every value the observability backends
		// guide lists for it, while the other two signals hold a different value:
		// returning a constant, ignoring the variable or reading a neighbouring
		// signal's variable all change one of the two compared results.
		const SIGNALS = [
			{ variable: "OTEL_TRACES_EXPORTER", key: "traces", others: ["OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"] },
			{ variable: "OTEL_METRICS_EXPORTER", key: "metrics", others: ["OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER"] },
			{ variable: "OTEL_LOGS_EXPORTER", key: "logs", others: ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER"] },
		] as const;
		const EXPLICIT_VALUES = ["console", "none", "otlp/http", "otlp/http-protobuf", "otlp/grpc"] as const;

		for (const { variable, key, others } of SIGNALS) {
			for (const value of EXPLICIT_VALUES) {
				it(`should read ${value} from ${variable} without touching the other signals`, () => {
					const bystander = value === "console" ? "none" : "console";
					for (const other of others) {
						process.env[other] = bystander;
					}
					process.env[variable] = value;

					const settings = getOTLPSettings();

					assert.strictEqual(settings[key], value);
					for (const otherKey of ["traces", "metrics", "logs"] as const) {
						if (otherKey !== key) {
							assert.strictEqual(settings[otherKey], bystander);
						}
					}
				});
			}
		}
	});

	describe("getCollectorOptions", () => {
		// The OpenTelemetry specification prescribes no exporter concurrency limit;
		// ten concurrent in-flight exports is a fixed Connectum choice in
		// getCollectorOptions(), not a standard value.
		it("should cap concurrent exports at the fixed Connectum limit of 10", () => {
			const options = getCollectorOptions();

			assert.strictEqual(options.concurrencyLimit, 10);
		});

		it("should remove trailing slash from URL", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/";

			const options = getCollectorOptions();

			assert.strictEqual(options.url, "http://localhost:4318");
		});

		// The OTLP/HTTP specification appends the signal path (v1/traces, ...) to the
		// base endpoint, so the base must end up without a trailing slash and must
		// otherwise stay exactly as the operator wrote it, including a path prefix
		// and the port. Only the single trailing slash is dropped.
		const ENDPOINTS = [
			{ input: "http://localhost:4318", expected: "http://localhost:4318", title: "a bare host and port" },
			{ input: "http://localhost:4318/", expected: "http://localhost:4318", title: "a trailing slash after the port" },
			{ input: "https://collector.example.com/otlp", expected: "https://collector.example.com/otlp", title: "a path prefix without a trailing slash" },
			{ input: "https://collector.example.com/otlp/", expected: "https://collector.example.com/otlp", title: "a path prefix with a trailing slash" },
		] as const;

		for (const { input, expected, title } of ENDPOINTS) {
			it(`should keep ${title} intact apart from the trailing slash`, () => {
				process.env.OTEL_EXPORTER_OTLP_ENDPOINT = input;

				assert.strictEqual(getCollectorOptions().url, expected);
			});
		}
	});

	describe("getBatchSpanProcessorOptions", () => {
		// Connectum deliberately uses its own batch defaults (batch 100, queue 1000,
		// delay 1000 ms, timeout 10000 ms), documented in the observability backends
		// guide and the JSDoc of getBatchSpanProcessorOptions(). They differ from the
		// OpenTelemetry specification defaults (512 / 2048 / 5000 ms / 30000 ms), so
		// the specification is not the oracle here: this pins the documented decision.
		it("should use the documented Connectum defaults, not the OpenTelemetry specification defaults", () => {
			delete process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE;
			delete process.env.OTEL_BSP_MAX_QUEUE_SIZE;
			delete process.env.OTEL_BSP_SCHEDULE_DELAY;
			delete process.env.OTEL_BSP_EXPORT_TIMEOUT;

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

		// The OpenTelemetry resource specification says an unset service.name is
		// "unknown_service" (underscore). Connectum falls back to "unknown-service"
		// (hyphen) and "0.0.0" for the version (the specification defines no default
		// version); both are documented in the observability backends guide. This pins
		// the documented Connectum fallbacks, not a standard value.
		it("should fall back to the documented Connectum defaults unknown-service and 0.0.0", () => {
			delete process.env.OTEL_SERVICE_NAME;
			delete process.env.npm_package_name;
			delete process.env.npm_package_version;

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "unknown-service");
			assert.strictEqual(metadata.version, "0.0.0");
		});

		// Name and version fall back independently: a missing name must not
		// discard a version that is present.
		it("should fall back to unknown-service while keeping a present version", () => {
			delete process.env.OTEL_SERVICE_NAME;
			delete process.env.npm_package_name;
			process.env.npm_package_version = "2.0.0";

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "unknown-service");
			assert.strictEqual(metadata.version, "2.0.0");
		});

		// Mirror case: a missing version falls back to the documented 0.0.0 while a
		// present name is kept.
		it("should fall back to 0.0.0 while keeping a present name", () => {
			delete process.env.OTEL_SERVICE_NAME;
			process.env.npm_package_name = "my-service";
			delete process.env.npm_package_version;

			const metadata = getServiceMetadata();

			assert.strictEqual(metadata.name, "my-service");
			assert.strictEqual(metadata.version, "0.0.0");
		});
	});
});
