/**
 * The exporter a signal uses when no `OTEL_*_EXPORTER` variable is set.
 *
 * The OpenTelemetry specification names `otlp` as the default exporter, `http/protobuf`
 * as the default protocol and `http://localhost:4318` as the default endpoint. A service
 * started without any variable must therefore send its telemetry over OTLP/HTTP and
 * must not print it. A collector that is not there must cost the service nothing but a
 * few diagnostic lines: no failed call, no line per record.
 */

import assert from "node:assert";
import http, { createServer, type IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, shutdownProvider } from "../../src/provider.ts";
import { traced } from "../../src/traced.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TIMEOUT",
] as const;

interface ReceivedRequest {
	path: string | undefined;
	contentType: string | undefined;
}

describe("provider: default exporter", () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(async () => {
		await shutdownProvider().catch(() => undefined);
		mock.restoreAll();
		syncBuiltinESMExports();
		context.disable();
		propagation.disable();
		trace.disable();
		metrics.disable();
		logs.disable();
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	function emitAllSignals(): void {
		const provider = getProvider();
		provider.tracer.startSpan("probe").end();
		provider.meter.createCounter("probe_total").add(1);
		provider.logger.emit({ body: "probe" });
	}

	it("sends traces, metrics and logs as protobuf over OTLP/HTTP to localhost:4318 when no variable is set", async () => {
		const received: ReceivedRequest[] = [];
		const server = createServer((req: IncomingMessage, res) => {
			received.push({ path: req.url, contentType: req.headers["content-type"] });
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/x-protobuf" });
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const targets: string[] = [];
		const original = http.request;
		// The exporters resolve "localhost:4318" themselves; redirect the connection to the test
		// collector after recording the URL they actually targeted.
		mock.method(http, "request", (...args: Parameters<typeof http.request>) => {
			const [url, ...rest] = args;
			assert.ok(url instanceof URL, "the exporter passes a parsed URL");
			targets.push(url.href);
			return (original as (...a: unknown[]) => ReturnType<typeof http.request>)(`http://127.0.0.1:${port}${url.pathname}`, ...rest);
		});
		syncBuiltinESMExports();
		try {
			emitAllSignals();
			await shutdownProvider();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		assert.deepStrictEqual([...targets].sort(), ["http://localhost:4318/v1/logs", "http://localhost:4318/v1/metrics", "http://localhost:4318/v1/traces"]);
		assert.deepStrictEqual(
			received.map((r) => r.contentType),
			["application/x-protobuf", "application/x-protobuf", "application/x-protobuf"],
		);
	});

	it("prints nothing to standard output when no variable is set", async () => {
		const printed: unknown[][] = [];
		const originalDir = console.dir;
		const originalLog = console.log;
		console.dir = (...args: unknown[]) => {
			printed.push(args);
		};
		console.log = (...args: unknown[]) => {
			printed.push(args);
		};
		try {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "200";
			emitAllSignals();
			await shutdownProvider().catch(() => undefined);
		} finally {
			console.dir = originalDir;
			console.log = originalLog;
		}

		// The provider's own "OTel provider shutdown..." line goes through console.debug and is not counted.
		assert.deepStrictEqual(printed, []);
	});

	it("still prints to standard output when the variable says console", async () => {
		process.env.OTEL_TRACES_EXPORTER = "console";
		process.env.OTEL_METRICS_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		// ConsoleSpanExporter prints each span with console.dir.
		const printed: unknown[] = [];
		const original = console.dir;
		console.dir = (value: unknown) => {
			printed.push(value);
		};
		try {
			getProvider().tracer.startSpan("console-probe").end();
			await shutdownProvider();
		} finally {
			console.dir = original;
		}

		assert.deepStrictEqual(
			printed.map((span) => (span as { name?: string }).name),
			["console-probe"],
		);
	});

	describe("with no collector listening", () => {
		it("fails no call and writes a handful of diagnostic lines, not one per record", async () => {
			// Nothing listens on port 1; a short timeout bounds the retries the exporter makes.
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "300";
			// The OpenTelemetry diagnostics logger keeps the console methods it found at load time, so
			// replacing console.error would miss its output; what reaches standard error is what counts.
			const diagnostics: string[] = [];
			const originalWrite = process.stderr.write;
			process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
				diagnostics.push(String(chunk));
				const callback = rest.find((arg): arg is () => void => typeof arg === "function");
				callback?.();
				return true;
			}) as typeof process.stderr.write;
			const records = 40;
			try {
				const provider = getProvider();
				const probe = traced(() => "ok", { name: "no-collector-probe" });
				for (let i = 0; i < records; i++) {
					assert.strictEqual(probe(), "ok");
					provider.logger.emit({ body: `record ${i}` });
				}
				provider.meter.createCounter("probe_total").add(1);
				await shutdownProvider().catch(() => undefined);
				// Failed exports are reported when their retries run out, which can be after shutdown has settled.
				await delay(1500);
			} finally {
				process.stderr.write = originalWrite;
			}

			const exportFailures = diagnostics.filter((line) => line.includes("ECONNREFUSED") || line.includes("export failed"));
			assert.ok(exportFailures.length >= 1, "the failure is reported at least once");
			assert.ok(exportFailures.length <= 4, `one line per distinct failure, not one per record; got ${exportFailures.length} for ${records} records`);
		});
	});
});
