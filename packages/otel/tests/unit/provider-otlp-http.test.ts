/**
 * OTLP/HTTP exporter wiring: where telemetry is sent when the collector endpoint
 * comes from the standard environment variables, and that a missing endpoint
 * falls back to the exporter default instead of failing provider construction.
 */

import assert from "node:assert";
import http, { createServer, type IncomingMessage, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

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

interface ReceivedRequest {
	method: string | undefined;
	path: string | undefined;
	contentType: string | undefined;
}

interface Collector {
	server: Server;
	origin: string;
	received: ReceivedRequest[];
}

async function startCollector(): Promise<Collector> {
	const received: ReceivedRequest[] = [];
	const server = createServer((req: IncomingMessage, res) => {
		received.push({ method: req.method, path: req.url, contentType: req.headers["content-type"] });
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, origin: `http://127.0.0.1:${port}`, received };
}

async function stopCollector(collector: Collector): Promise<void> {
	collector.server.closeAllConnections();
	await new Promise<void>((resolve) => collector.server.close(() => resolve()));
}

function setOnly(signal: "traces" | "metrics" | "logs", exporter = "otlp/http"): void {
	for (const s of ["traces", "metrics", "logs"] as const) {
		process.env[`OTEL_${s.toUpperCase()}_EXPORTER`] = s === signal ? exporter : "none";
	}
}

describe("provider: OTLP/HTTP exporters", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector | undefined;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(async () => {
		await shutdownProvider();
		mock.restoreAll();
		syncBuiltinESMExports();
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

	// The OTLP exporter specification: with no endpoint configured the exporter sends
	// to http://localhost:4318, appending /v1/traces, /v1/metrics or /v1/logs. The
	// outgoing request is redirected to the local collector, with the URL the
	// exporter actually targeted recorded first.
	function recordTargets(redirectOrigin: string): string[] {
		const targets: string[] = [];
		const original = http.request;
		mock.method(http, "request", (...args: Parameters<typeof http.request>) => {
			const [url, ...rest] = args;
			assert.ok(url instanceof URL, "the exporter passes a parsed URL");
			targets.push(url.href);
			return (original as (...a: unknown[]) => ReturnType<typeof http.request>)(`${redirectOrigin}${url.pathname}`, ...rest);
		});
		syncBuiltinESMExports();
		return targets;
	}

	const defaultTargets = {
		traces: "http://localhost:4318/v1/traces",
		metrics: "http://localhost:4318/v1/metrics",
		logs: "http://localhost:4318/v1/logs",
	} as const;

	for (const signal of ["traces", "metrics", "logs"] as const) {
		it(`sends ${signal} to ${defaultTargets[signal]} when no endpoint is configured`, async () => {
			collector = await startCollector();
			const targets = recordTargets(collector.origin);
			setOnly(signal);

			emitProbe[signal](getProvider());
			await shutdownProvider();

			assert.deepStrictEqual(targets, [defaultTargets[signal]]);
		});
	}

	it("applies explicit settings overrides, sending every signal to the default endpoint when none is configured", async () => {
		collector = await startCollector();
		const targets = recordTargets(collector.origin);

		initProvider({ settings: { traces: "otlp/http", metrics: "otlp/http", logs: "otlp/http" } });
		const provider = getProvider();
		emitProbe.traces(provider);
		emitProbe.metrics(provider);
		emitProbe.logs(provider);
		await shutdownProvider();

		assert.deepStrictEqual([...targets].sort(), [defaultTargets.logs, defaultTargets.metrics, defaultTargets.traces]);
	});

	it("sends spans to <endpoint>/v1/traces", async () => {
		collector = await startCollector();
		setOnly("traces");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

		const provider = getProvider();
		provider.tracer.startSpan("probe").end();
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => [r.method, r.path]),
			[["POST", "/v1/traces"]],
		);
		assert.strictEqual(collector.received[0]?.contentType, "application/json");
	});

	it("sends metrics to <endpoint>/v1/metrics", async () => {
		collector = await startCollector();
		setOnly("metrics");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

		const provider = getProvider();
		provider.meter.createCounter("probe_total").add(1);
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => [r.method, r.path]),
			[["POST", "/v1/metrics"]],
		);
	});

	it("sends logs to <endpoint>/v1/logs", async () => {
		collector = await startCollector();
		setOnly("logs");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

		const provider = getProvider();
		provider.logger.emit({ body: "probe" });
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => [r.method, r.path]),
			[["POST", "/v1/logs"]],
		);
	});

	it("tolerates a trailing slash on the endpoint", async () => {
		collector = await startCollector();
		setOnly("traces");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${collector.origin}/`;

		getProvider().tracer.startSpan("probe").end();
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => r.path),
			["/v1/traces"],
		);
	});

	it("uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim and ahead of the base endpoint", async () => {
		collector = await startCollector();
		setOnly("traces");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${collector.origin}/custom/spans`;

		getProvider().tracer.startSpan("probe").end();
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => r.path),
			["/custom/spans"],
		);
	});

	it("uses a per-signal endpoint when no base endpoint is set", async () => {
		collector = await startCollector();
		setOnly("logs");
		process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${collector.origin}/custom/logs`;

		getProvider().logger.emit({ body: "probe" });
		await shutdownProvider();

		assert.deepStrictEqual(
			collector.received.map((r) => r.path),
			["/custom/logs"],
		);
	});

	const emitProbe = {
		traces: (p: ReturnType<typeof getProvider>) => p.tracer.startSpan("probe").end(),
		metrics: (p: ReturnType<typeof getProvider>) => p.meter.createCounter("probe_total").add(1),
		logs: (p: ReturnType<typeof getProvider>) => p.logger.emit({ body: "probe" }),
	};
	const wireFormats = [
		{ label: "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf", exporter: "otlp", protocol: "http/protobuf", contentType: "application/x-protobuf" },
		{ label: "no protocol variable (specification default)", exporter: "otlp", protocol: undefined, contentType: "application/x-protobuf" },
		{ label: "OTEL_EXPORTER_OTLP_PROTOCOL=http/json", exporter: "otlp", protocol: "http/json", contentType: "application/json" },
		{ label: "explicit otlp/http-protobuf", exporter: "otlp/http-protobuf", protocol: undefined, contentType: "application/x-protobuf" },
		{ label: "explicit otlp/http", exporter: "otlp/http", protocol: undefined, contentType: "application/json" },
	] as const;

	for (const signal of ["traces", "metrics", "logs"] as const) {
		for (const { label, exporter, protocol, contentType } of wireFormats) {
			it(`sends ${signal} as ${contentType} for ${label}`, async () => {
				collector = await startCollector();
				setOnly(signal, exporter);
				if (protocol !== undefined) {
					process.env.OTEL_EXPORTER_OTLP_PROTOCOL = protocol;
				}
				process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

				emitProbe[signal](getProvider());
				await shutdownProvider();

				assert.strictEqual(collector.received.length, 1);
				assert.strictEqual(collector.received[0]?.contentType, contentType);
			});
		}
	}

	// Creating the provider happens inside the first instrumented call. Throwing for a bad endpoint
	// there failed that call and every later one, so the endpoint is reported with a process warning
	// and ignored; the exporter then uses its own default address.
	it("reports a malformed base endpoint with a warning at construction instead of throwing", async () => {
		setOnly("traces");
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not a url";
		const warnings: Array<Error & { code?: string }> = [];
		const onWarning = (warning: Error & { code?: string }) => {
			warnings.push(warning);
		};
		process.on("warning", onWarning);
		try {
			assert.doesNotThrow(() => getProvider());
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("warning", onWarning);
		}

		const about = warnings.filter((warning) => warning.message.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
		assert.strictEqual(about.length, 1);
		assert.strictEqual(about[0]?.code, "CONNECTUM_OTEL_INVALID_ENV");
		assert.ok(about[0]?.message.includes('"not a url"'));
	});
});
