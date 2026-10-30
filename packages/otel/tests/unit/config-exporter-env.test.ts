/**
 * Exporter, protocol and endpoint variables that are empty, mis-cased or invalid.
 *
 * The provider is created lazily inside the first instrumented call, so a
 * configuration problem that throws would fail that call, and the next one, and
 * every one after it, while the provider stays uncreated. The OpenTelemetry
 * specification asks for the opposite: an empty value is the same as an unset one,
 * enum values are case-insensitive, and an unrecognised value is reported with a
 * warning and ignored.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getCollectorOptions, getGrpcExporterOptions, getHttpExporterOptions, getOTLPSettings } from "../../src/config.ts";

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

describe("config: invalid exporter, protocol and endpoint variables", () => {
	const saved = new Map<string, string | undefined>();
	let warnings: Array<Error & { code?: string }> = [];
	const onWarning = (warning: Error & { code?: string }) => {
		warnings.push(warning);
	};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		warnings = [];
		process.on("warning", onWarning);
	});

	afterEach(() => {
		process.off("warning", onWarning);
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	/** Process warnings are delivered on a later tick; wait for it, then keep the ones that name the variable. */
	async function warningsAbout(variable: string): Promise<Array<Error & { code?: string }>> {
		await new Promise((resolve) => setImmediate(resolve));
		return warnings.filter((warning) => warning.message.includes(variable));
	}

	describe("exporter variables", () => {
		const SIGNALS = [
			{ variable: "OTEL_TRACES_EXPORTER", key: "traces" },
			{ variable: "OTEL_METRICS_EXPORTER", key: "metrics" },
			{ variable: "OTEL_LOGS_EXPORTER", key: "logs" },
		] as const;

		for (const { variable, key } of SIGNALS) {
			it(`${variable} set to an empty string is the same as unset: the documented default, no warning`, async () => {
				process.env[variable] = "";

				assert.strictEqual(getOTLPSettings()[key], "otlp/http-protobuf");
				assert.deepStrictEqual(await warningsAbout(variable), []);
			});

			it(`${variable} is matched case-insensitively`, async () => {
				process.env[variable] = "OTLP/GRPC";

				assert.strictEqual(getOTLPSettings()[key], "otlp/grpc");
				assert.deepStrictEqual(await warningsAbout(variable), []);
			});

			for (const unknown of ["otlp,console", "jaeger", "zipkin", "logging", "prometheus", "bogus"]) {
				it(`${variable}=${unknown} warns once, naming the variable and the value, and falls back to the default`, async () => {
					process.env[variable] = unknown;

					assert.doesNotThrow(() => getOTLPSettings());
					assert.strictEqual(getOTLPSettings()[key], "otlp/http-protobuf");

					const about = await warningsAbout(variable);
					// getOTLPSettings() ran twice above, one warning each.
					assert.strictEqual(about.length, 2);
					assert.strictEqual(about[0]?.code, "CONNECTUM_OTEL_INVALID_ENV");
					assert.ok(about[0]?.message.includes(`"${unknown}"`), `the warning should quote the rejected value: ${about[0]?.message}`);
				});
			}
		}

		it("an invalid value on one signal leaves the other signals as configured", async () => {
			process.env.OTEL_TRACES_EXPORTER = "bogus";
			process.env.OTEL_METRICS_EXPORTER = "none";
			process.env.OTEL_LOGS_EXPORTER = "OTLP/HTTP";

			assert.deepStrictEqual(getOTLPSettings(), { traces: "otlp/http-protobuf", metrics: "none", logs: "otlp/http" });
			assert.strictEqual((await warningsAbout("OTEL_TRACES_EXPORTER")).length, 1);
			assert.deepStrictEqual(await warningsAbout("OTEL_METRICS_EXPORTER"), []);
		});
	});

	describe("the default exporter", () => {
		// The OpenTelemetry specification names `otlp` as the default exporter, with
		// `http/protobuf` as the default protocol. An unset variable must resolve exactly
		// as the explicit `otlp` value does, protocol variables included.
		it("is OTLP/HTTP protobuf for every signal when no exporter variable is set", () => {
			assert.deepStrictEqual(getOTLPSettings(), { traces: "otlp/http-protobuf", metrics: "otlp/http-protobuf", logs: "otlp/http-protobuf" });
		});

		it("follows the general protocol variable, as the explicit `otlp` value does", () => {
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

			assert.deepStrictEqual(getOTLPSettings(), { traces: "otlp/grpc", metrics: "otlp/grpc", logs: "otlp/grpc" });
		});

		it("follows the per-signal protocol variable over the general one", () => {
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json";

			assert.deepStrictEqual(getOTLPSettings(), { traces: "otlp/grpc", metrics: "otlp/grpc", logs: "otlp/http" });
		});

		it("leaves `console` and `none` working when set explicitly", () => {
			process.env.OTEL_TRACES_EXPORTER = "console";
			process.env.OTEL_METRICS_EXPORTER = "none";

			assert.deepStrictEqual(getOTLPSettings(), { traces: "console", metrics: "none", logs: "otlp/http-protobuf" });
		});
	});

	describe("protocol variables", () => {
		it("an empty OTEL_EXPORTER_OTLP_PROTOCOL is the same as unset", async () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "";

			assert.strictEqual(getOTLPSettings().traces, "otlp/http-protobuf");
			assert.deepStrictEqual(await warningsAbout("OTEL_EXPORTER_OTLP_PROTOCOL"), []);
		});

		it("an empty per-signal protocol does not hide the general one", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

			assert.strictEqual(getOTLPSettings().traces, "otlp/grpc");
		});

		it("is matched case-insensitively", () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "HTTP/JSON";

			assert.strictEqual(getOTLPSettings().traces, "otlp/http");
		});

		it("an unknown protocol warns and falls back to the general one, then to protobuf over HTTP", async () => {
			process.env.OTEL_TRACES_EXPORTER = "otlp";
			process.env.OTEL_METRICS_EXPORTER = "otlp";
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "carrier-pigeon";
			process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

			const settings = getOTLPSettings();

			assert.strictEqual(settings.traces, "otlp/grpc", "the broken per-signal value is ignored, the general one applies");
			assert.strictEqual(settings.metrics, "otlp/grpc");
			const about = await warningsAbout("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL");
			assert.strictEqual(about.length, 1);
			assert.ok(about[0]?.message.includes('"carrier-pigeon"'));

			delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
			assert.strictEqual(getOTLPSettings().traces, "otlp/http-protobuf");
		});
	});

	describe("OTLP endpoints over HTTP", () => {
		it("an endpoint without a scheme warns and is ignored", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "localhost:4318";

			const options = getHttpExporterOptions(getCollectorOptions(), "TRACES");

			// Left out, the exporter would read the broken variable from the environment itself and fail on
			// the first export with `Protocol "localhost:" not supported`, so the default is passed explicitly.
			assert.strictEqual(options.url, "http://localhost:4318/v1/traces");
			const about = await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT");
			assert.ok(about.length >= 1);
			assert.strictEqual(about[0]?.code, "CONNECTUM_OTEL_INVALID_ENV");
			assert.ok(about[0]?.message.includes('"localhost:4318"'));
		});

		it("an endpoint that is not a URL warns once when the collector options are read, and is ignored", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not a url";

			assert.doesNotThrow(() => getCollectorOptions());
			assert.strictEqual(getCollectorOptions().url, undefined);

			const about = await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT");
			assert.strictEqual(about.length, 2);
			assert.ok(about[0]?.message.includes('"not a url"'));
		});

		for (const scheme of ["ftp", "file", "ws"]) {
			it(`an endpoint with the ${scheme}: scheme is not usable over HTTP`, () => {
				process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${scheme}://collector:4318`;

				assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "METRICS").url, "http://localhost:4318/v1/metrics");
			});
		}

		it("an https endpoint is used", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example:4318";

			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "LOGS").url, "https://collector.example:4318/v1/logs");
		});

		it("an unusable per-signal endpoint is replaced by the base endpoint, not read again by the exporter", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "tempo:4318/v1/traces";

			const options = getHttpExporterOptions(getCollectorOptions(), "TRACES");

			assert.strictEqual(options.url, "http://collector:4318/v1/traces");
			const about = await warningsAbout("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
			assert.strictEqual(about.length, 1);
			assert.ok(about[0]?.message.includes('"tempo:4318/v1/traces"'));
		});

		it("an unusable per-signal endpoint without a base endpoint gets the explicit exporter default", () => {
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "tempo:4318/v1/traces";

			// The exporter reads the variable itself when no URL is passed, so the default is passed explicitly.
			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "TRACES").url, "http://localhost:4318/v1/traces");
		});

		it("a usable per-signal endpoint is still left to the exporter, as given", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://tempo:4318/custom";

			assert.strictEqual(getHttpExporterOptions(getCollectorOptions(), "TRACES").url, undefined);
		});
	});

	describe("OTLP endpoints over gRPC", () => {
		// The OTLP/gRPC exporter of the SDK normalises a bare `host:port` itself, so it is a valid
		// gRPC endpoint even though the same text is unusable for OTLP/HTTP.
		it("a bare host and port is passed through without a warning", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "localhost:4317";

			assert.strictEqual(getGrpcExporterOptions(getCollectorOptions(), "TRACES").url, "localhost:4317");
			assert.deepStrictEqual(await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT"), []);
		});

		it("a base endpoint takes precedence over a per-signal endpoint, as documented", () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://tempo:4317";

			assert.strictEqual(getGrpcExporterOptions(getCollectorOptions(), "TRACES").url, "http://collector:4317");
		});

		// The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself when no url is passed and throws for text
		// that is not a URL, which would fail the call that creates the provider.
		it("an endpoint that is not a URL is replaced by the explicit exporter default, not read again by the exporter", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not a url";

			assert.strictEqual(getGrpcExporterOptions(getCollectorOptions(), "METRICS").url, "http://localhost:4317");
			assert.ok((await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT")).length >= 1);
		});

		it("an unusable per-signal endpoint is replaced by the explicit exporter default", async () => {
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "not a url";

			assert.strictEqual(getGrpcExporterOptions(getCollectorOptions(), "TRACES").url, "http://localhost:4317");
			assert.strictEqual((await warningsAbout("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")).length, 1);
		});

		it("leaves the url out when nothing is configured so the exporter default applies", () => {
			assert.deepStrictEqual(Object.keys(getGrpcExporterOptions(getCollectorOptions(), "LOGS")), ["concurrencyLimit"]);
		});
	});
});
