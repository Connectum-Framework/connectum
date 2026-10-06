/**
 * Provider lifecycle: what `shutdownProvider()` guarantees when the collector is
 * unreachable, how the three signals are stopped independently, and that the
 * process-wide OpenTelemetry API registrations the provider took are released
 * (and only those) so a later `initProvider()` starts from a clean state.
 */

import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import type { ProviderOptions } from "../../src/provider.ts";
import { getProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
] as const;

const OTLP_HTTP: NonNullable<ProviderOptions["settings"]> = { traces: "otlp/http", metrics: "otlp/http", logs: "otlp/http" };

interface Collector {
	server: Server;
	origin: string;
	paths: string[];
}

async function startCollector(): Promise<Collector> {
	const paths: string[] = [];
	const server = createServer((req: IncomingMessage, res) => {
		paths.push(req.url ?? "");
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { server, origin: `http://127.0.0.1:${port}`, paths };
}

async function stopCollector(collector: Collector): Promise<void> {
	collector.server.closeAllConnections();
	await new Promise<void>((resolve) => collector.server.close(() => resolve()));
}

/** An origin on which nothing listens: connecting is refused immediately. */
async function closedOrigin(): Promise<string> {
	const collector = await startCollector();
	await stopCollector(collector);
	return collector.origin;
}

type Slot = "trace" | "context" | "propagation" | "metrics" | "logs";

/**
 * Tries to take every process-wide OpenTelemetry API slot with a probe and
 * reports which were free. The probes it managed to register are removed again,
 * so a slot held by someone else is neither reported free nor disturbed.
 */
function freeSlots(): Record<Slot, boolean> {
	const loggerProbe = new LoggerProvider();
	const free: Record<Slot, boolean> = {
		trace: trace.setGlobalTracerProvider(new NodeTracerProvider()),
		context: context.setGlobalContextManager(new AsyncLocalStorageContextManager()),
		propagation: propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] })),
		metrics: metrics.setGlobalMeterProvider(new MeterProvider()),
		logs: logs.setGlobalLoggerProvider(loggerProbe) === loggerProbe,
	};
	if (free.trace) trace.disable();
	if (free.context) context.disable();
	if (free.propagation) propagation.disable();
	if (free.metrics) metrics.disable();
	if (free.logs) logs.disable();
	return free;
}

const ALL_FREE: Record<Slot, boolean> = { trace: true, context: true, propagation: true, metrics: true, logs: true };

describe("provider lifecycle", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector | undefined;

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		collector = await startCollector();
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;
	});

	afterEach(async () => {
		mock.restoreAll();
		try {
			await shutdownProvider();
		} catch {
			// A test that provoked a failing shutdown has already asserted on it.
		}
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

	describe("shutdown with an unreachable collector", () => {
		it("rejects, yet leaves no stopped provider behind", async () => {
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = await closedOrigin();
			initProvider({ settings: { traces: "otlp/http", metrics: "none", logs: "none" } });
			const stopped = getProvider();
			stopped.tracer.startSpan("probe").end();

			await assert.rejects(shutdownProvider());

			assert.deepStrictEqual(freeSlots(), ALL_FREE, "the tracer, context and propagator registrations are released although shutdown failed");
			await assert.doesNotReject(shutdownProvider(), "a second shutdown has nothing left to stop");
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector?.origin;
			initProvider({ settings: { traces: "otlp/http", metrics: "none", logs: "none" } });
			const fresh = getProvider();
			assert.notStrictEqual(fresh, stopped, "getProvider() must not hand out the provider whose shutdown failed");

			fresh.tracer.startSpan("after").end();
			await shutdownProvider();
			assert.deepStrictEqual(collector?.paths, ["/v1/traces"], "the fresh provider exports to the reachable collector");
		});
	});

	describe("independent shutdown of the three signals", () => {
		const traceError = new Error("trace shutdown failed");
		const metricsError = new Error("metrics shutdown failed");
		const logsError = new Error("logs shutdown failed");

		/** Wraps a real `shutdown` so the SDK still stops, then reports the given failure. */
		function failAfterRealShutdown(prototype: { shutdown(): Promise<void> }, error: Error): void {
			const real = prototype.shutdown;
			mock.method(prototype, "shutdown", async function (this: { shutdown(): Promise<void> }): Promise<void> {
				await real.call(this);
				throw error;
			});
		}

		it("still stops metrics and logs when the tracer fails, and reports that error as is", async () => {
			initProvider({ settings: OTLP_HTTP });
			failAfterRealShutdown(NodeTracerProvider.prototype, traceError);
			const metricsShutdown = mock.method(MeterProvider.prototype, "shutdown");
			const logsShutdown = mock.method(LoggerProvider.prototype, "shutdown");

			await assert.rejects(shutdownProvider(), (error: unknown) => error === traceError);

			assert.strictEqual(metricsShutdown.mock.callCount(), 1);
			assert.strictEqual(logsShutdown.mock.callCount(), 1);
		});

		it("reports every failure in an AggregateError when more than one signal fails", async () => {
			initProvider({ settings: OTLP_HTTP });
			failAfterRealShutdown(NodeTracerProvider.prototype, traceError);
			const metricsShutdown = mock.method(MeterProvider.prototype, "shutdown");
			failAfterRealShutdown(LoggerProvider.prototype, logsError);

			await assert.rejects(shutdownProvider(), (error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.deepStrictEqual(error.errors, [traceError, logsError]);
				return true;
			});

			assert.strictEqual(metricsShutdown.mock.callCount(), 1);
		});

		it("reports a metrics failure as is and releases every registration", async () => {
			initProvider({ settings: OTLP_HTTP });
			failAfterRealShutdown(MeterProvider.prototype, metricsError);

			await assert.rejects(shutdownProvider(), (error: unknown) => error === metricsError);

			assert.deepStrictEqual(freeSlots(), ALL_FREE);
		});
	});

	describe("process-wide OpenTelemetry API registrations", () => {
		it("takes all five slots while running and frees all of them on shutdown", async () => {
			initProvider({ settings: OTLP_HTTP });
			assert.deepStrictEqual(freeSlots(), { trace: false, context: false, propagation: false, metrics: false, logs: false });

			await shutdownProvider();

			assert.deepStrictEqual(freeSlots(), ALL_FREE);
		});

		it("frees them when the instance is shut down directly, while getProvider() keeps returning it", async () => {
			initProvider({ settings: OTLP_HTTP });
			const instance = getProvider();

			await instance.shutdown();

			assert.deepStrictEqual(freeSlots(), ALL_FREE);
			assert.strictEqual(getProvider(), instance);
		});

		it("leaves a registration that belongs to someone else alone", async () => {
			const foreignTracer = new NodeTracerProvider();
			const foreignMeter = new MeterProvider();
			trace.setGlobalTracerProvider(foreignTracer);
			metrics.setGlobalMeterProvider(foreignMeter);

			// The API reports each refused registration through its diagnostic logger.
			mock.method(console, "error", () => {});
			initProvider({ settings: OTLP_HTTP });
			const own = getProvider();
			own.tracer.startSpan("own").end();
			own.meter.createCounter("own_total").add(1);
			await shutdownProvider();

			assert.ok(collector?.paths.includes("/v1/traces"), "the provider's own tracer exports although the global slot is taken");
			assert.ok(collector?.paths.includes("/v1/metrics"), "the provider's own meter exports although the global slot is taken");
			assert.strictEqual(trace.getTracer("probe").startSpan("s").isRecording(), true, "the foreign tracer provider is still registered");
			assert.deepStrictEqual(freeSlots(), { trace: false, context: true, propagation: true, metrics: false, logs: true });
		});

		it("re-initializes with a working meter and without a duplicate-registration diagnostic", async () => {
			initProvider({ settings: OTLP_HTTP });
			await shutdownProvider();
			collector?.paths.splice(0);

			const diagnostics = mock.method(console, "error", () => {});
			initProvider({ settings: OTLP_HTTP });
			getProvider().meter.createCounter("again_total").add(1);
			await shutdownProvider();

			const duplicates = diagnostics.mock.calls.filter((call) => String(call.arguments[0]).includes("duplicate registration"));
			assert.deepStrictEqual(duplicates, []);
			assert.deepStrictEqual(collector?.paths, ["/v1/metrics"]);
		});
	});

	describe("interceptors created before a shutdown", () => {
		const METRICS_ONLY: NonNullable<ProviderOptions["settings"]> = { traces: "none", metrics: "otlp/http", logs: "none" };
		const message = { toBinary: () => new Uint8Array(1) };

		const interceptors = {
			server: () => createOtelInterceptor(),
			client: () => createOtelClientInterceptor({ serverAddress: "localhost", serverPort: 5000 }),
		};

		for (const [side, create] of Object.entries(interceptors)) {
			it(`${side} interceptor keeps exporting metrics after the provider was shut down and created again`, async () => {
				const interceptor = create();
				const call = async () => interceptor(createMockNext({ message }))(createMockRequest({ message }));

				initProvider({ settings: METRICS_ONLY });
				await call();
				await shutdownProvider();
				assert.deepStrictEqual(collector?.paths, ["/v1/metrics"], "the first provider exports the recorded call");
				collector?.paths.splice(0);

				initProvider({ settings: METRICS_ONLY });
				await call();
				await shutdownProvider();

				assert.deepStrictEqual(collector?.paths, ["/v1/metrics"], "the second provider must receive the call made through the same interceptor");
			});
		}
	});
});
