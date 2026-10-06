/**
 * Resolution of the standard `otlp` exporter value through the OTLP protocol
 * variables, and of the collector endpoint for the OTLP/HTTP exporters.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getCollectorOptions, getHttpExporterOptions, getOTLPSettings } from "../../src/config.ts";

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
] as const;

describe("config: otlp exporter value and protocol", () => {
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

	describe("getOTLPSettings with OTEL_*_EXPORTER=otlp", () => {
		it("selects protobuf-encoded OTLP/HTTP when no protocol is configured", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_METRICS_EXPORTER = "otlp";
			process.env.OTEL_LOGS_EXPORTER = "otlp";

			assert.deepStrictEqual(getOTLPSettings(), { traces: "otlp/http-protobuf", metrics: "otlp/http-protobuf", logs: "otlp/http-protobuf" });
		});

		it("selects OTLP/gRPC for OTEL_EXPORTER_OTLP_PROTOCOL=grpc", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

			assert.strictEqual(getOTLPSettings().traces, "otlp/grpc");
		});

		const httpEncodings = [
			["http/protobuf", "otlp/http-protobuf"],
			["http/json", "otlp/http"],
		] as const;
		for (const [protocol, exporter] of httpEncodings) {
			it(`maps OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} to the ${exporter} exporter`, () => {
				process.env.OTEL_METRICS_EXPORTER = "otlp";
				process.env.OTEL_EXPORTER_OTLP_PROTOCOL = protocol;

				assert.strictEqual(getOTLPSettings().metrics, exporter);
			});
		}

		it("lets a per-signal protocol override the general protocol for that signal only", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_LOGS_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.traces, "otlp/grpc");
			assert.strictEqual(settings.logs, "otlp/http");
		});

		it("rejects an unknown protocol instead of silently picking one", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "carrier-pigeon";

			assert.throws(() => getOTLPSettings(), /OTEL_EXPORTER_OTLP_PROTOCOL/);
		});

		it("keeps an explicit otlp/http, otlp/http-protobuf or otlp/grpc value regardless of the protocol variable", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp/http";
			process.env.OTEL_METRICS_EXPORTER = "otlp/grpc";
			process.env.OTEL_LOGS_EXPORTER = "otlp/http-protobuf";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.traces, "otlp/http");
			assert.strictEqual(settings.metrics, "otlp/grpc");
			assert.strictEqual(settings.logs, "otlp/http-protobuf");
		});

		it("does not validate the protocol variable when no signal uses the bare otlp value", () => {
			process.env.OTEL_TRACES_EXPORTER = "console";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "carrier-pigeon";

			assert.doesNotThrow(() => getOTLPSettings());
		});
	});

	describe("getCollectorOptions", () => {
		it("treats an empty OTEL_EXPORTER_OTLP_ENDPOINT as not set", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";

			assert.strictEqual(getCollectorOptions().url, undefined);
		});
	});

	describe("getHttpExporterOptions", () => {
		it("omits the url without any endpoint so the exporter default applies", () => {
			const options = getHttpExporterOptions(getCollectorOptions(), "TRACES");

			assert.deepStrictEqual(options, { concurrencyLimit: 10 });
		});

		it("appends the signal path to the base endpoint", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/";

			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "TRACES").url, "http://collector:4318/v1/traces");
			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "METRICS").url, "http://collector:4318/v1/metrics");
			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "LOGS").url, "http://collector:4318/v1/logs");
		});

		it("omits the url when a per-signal endpoint is set so that endpoint is used as given", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://metrics:9000/custom";

			assert.deepStrictEqual(getHttpExporterOptions(getCollectorOptions(), "METRICS"), { concurrencyLimit: 10 });
			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "TRACES").url, "http://collector:4318/v1/traces");
		});
	});
});
