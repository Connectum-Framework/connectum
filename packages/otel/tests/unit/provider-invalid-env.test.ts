/**
 * An invalid exporter, protocol or endpoint variable must not fail the RPCs.
 *
 * The provider is created by the first instrumented call. Before, an empty
 * `OTEL_TRACES_EXPORTER` (or `OTLP`, or `otlp,console`) made that creation throw, the
 * provider stayed uncreated, and every call after it failed with `internal` while the
 * cause stayed on the server. Instrumentation runs identically for the HTTP and the
 * in-process transport (it is one provider read inside the interceptor), so the call goes
 * straight through the interceptor and no transport scenario is needed.
 */

import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TIMEOUT",
] as const;

const message = { toBinary: () => new Uint8Array(1) };

interface Collector {
	server: Server;
	origin: string;
	received: Array<{ path: string; contentType: string | undefined }>;
}

async function startCollector(): Promise<Collector> {
	const received: Collector["received"] = [];
	const server = createServer((req: IncomingMessage, res) => {
		received.push({ path: req.url ?? "", contentType: req.headers["content-type"] });
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

describe("an invalid exporter, protocol or endpoint variable", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector | undefined;
	let warnings: Array<Error & { code?: string }> = [];
	const onWarning = (warning: Error & { code?: string }) => {
		warnings.push(warning);
	};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.OTEL_METRICS_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		warnings = [];
		process.on("warning", onWarning);
	});

	afterEach(async () => {
		process.off("warning", onWarning);
		try {
			await shutdownProvider();
		} catch {
			// A test that sent to an unreachable collector has already asserted on it.
		}
		// After the shutdown: that is when the console exporter prints the pending spans.
		mock.restoreAll();
		context.disable();
		propagation.disable();
		trace.disable();
		metrics.disable();
		logs.disable();
		if (collector) {
			collector.server.closeAllConnections();
			await new Promise<void>((resolve) => collector?.server.close(() => resolve()));
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

	/** One RPC through the server interceptor, which creates the provider on first use. */
	async function rpc(): Promise<unknown> {
		const interceptor = createOtelInterceptor();
		return interceptor(createMockNext({ message }))(createMockRequest({ message }));
	}

	async function warningsAbout(variable: string): Promise<Array<Error & { code?: string }>> {
		await new Promise((resolve) => setImmediate(resolve));
		return warnings.filter((warning) => warning.message.includes(variable));
	}

	for (const bad of ["", "jaeger", "otlp,console", "bogus"]) {
		it(`OTEL_TRACES_EXPORTER=${JSON.stringify(bad)} does not fail any of the first three calls`, async () => {
			process.env.OTEL_TRACES_EXPORTER = bad;
			// The default exporter writes spans to standard output; keep the test log clean.
			mock.method(console, "dir", () => {});

			for (let call = 0; call < 3; call++) {
				await assert.doesNotReject(rpc(), `call ${call}`);
			}

			const about = await warningsAbout("OTEL_TRACES_EXPORTER");
			assert.strictEqual(about.length, bad === "" ? 0 : 1, "one warning when the provider was created, none for an empty value");
		});
	}

	it("OTEL_EXPORTER_OTLP_PROTOCOL set to an empty string does not fail a call and means protobuf over HTTP", async () => {
		collector = await startCollector();
		process.env.OTEL_TRACES_EXPORTER = "otlp";
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

		await assert.doesNotReject(rpc());
		await shutdownProvider();

		assert.deepStrictEqual(collector.received, [{ path: "/v1/traces", contentType: "application/x-protobuf" }]);
	});

	it("an exporter name in upper case selects that exporter", async () => {
		collector = await startCollector();
		process.env.OTEL_TRACES_EXPORTER = "OTLP/HTTP";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

		await assert.doesNotReject(rpc());
		await shutdownProvider();

		assert.deepStrictEqual(collector.received, [{ path: "/v1/traces", contentType: "application/json" }]);
	});

	it("an endpoint without a scheme is reported when the provider is created, not when it is shut down", async () => {
		process.env.OTEL_TRACES_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "localhost:4318";

		await assert.doesNotReject(rpc());

		const about = await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT");
		assert.strictEqual(about.length, 1);
		assert.strictEqual(about[0]?.code, "CONNECTUM_OTEL_INVALID_ENV");
		assert.ok(about[0]?.message.includes('"localhost:4318"'));
	});

	it("an endpoint that is not a URL does not fail any call", async () => {
		process.env.OTEL_TRACES_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not a url";

		for (let call = 0; call < 3; call++) {
			await assert.doesNotReject(rpc(), `call ${call}`);
		}
		assert.strictEqual((await warningsAbout("OTEL_EXPORTER_OTLP_ENDPOINT")).length, 1);
	});

	for (const exporter of ["otlp/http", "otlp/http-protobuf", "otlp/grpc"]) {
		for (const endpoint of ["not a url", "localhost:4318"]) {
			if (exporter === "otlp/grpc" && endpoint === "localhost:4318") continue; // a valid gRPC endpoint
			it(`${exporter} with OTEL_EXPORTER_OTLP_ENDPOINT=${JSON.stringify(endpoint)} still creates the provider (the exporter does not read the variable again)`, async () => {
				process.env.OTEL_TRACES_EXPORTER = exporter;
				process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
				// The spans go to the exporter default, where nothing listens; keep the final flush short.
				process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "200";

				for (let call = 0; call < 2; call++) {
					await assert.doesNotReject(rpc(), `call ${call}`);
				}
			});
		}
	}

	it("an unusable per-signal endpoint is not read again by the exporter: the base endpoint receives the spans", async () => {
		collector = await startCollector();
		process.env.OTEL_TRACES_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "tempo:4318/v1/traces";

		await assert.doesNotReject(rpc());
		await shutdownProvider();

		assert.deepStrictEqual(collector.received, [{ path: "/v1/traces", contentType: "application/json" }]);
	});
});
