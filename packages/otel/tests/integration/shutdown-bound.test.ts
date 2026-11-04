/**
 * How long `shutdownProvider()` takes when the collector is unavailable, per exporter
 * transport, and what bounds it.
 *
 * The numbers in the backends guide come from this file. It is slow (the defaults are
 * measured, ten seconds per hanging case) and is skipped unless CONNECTUM_SHUTDOWN_BOUND=1
 * is set. Each case prints one line: `transport mode timeout -> outcome in N ms`.
 *
 * Two kinds of unavailable collector are used: a port nothing listens on (the connection is
 * refused at once, the exporter retries within its timeout) and a server that accepts the
 * connection and never answers.
 */

import assert from "node:assert";
import net from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

const ENABLED = process.env.CONNECTUM_SHUTDOWN_BOUND === "1";
const ENV_KEYS = ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TIMEOUT"] as const;
const TRANSPORTS = ["otlp/http", "otlp/http-protobuf", "otlp/grpc"] as const;

async function listen(server: net.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as net.AddressInfo).port;
}

/** A port on which nothing listens. */
async function refusedPort(): Promise<number> {
	const probe = net.createServer();
	const port = await listen(probe);
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

describe("shutdownProvider with an unavailable collector", { skip: !ENABLED }, () => {
	const saved = new Map<string, string | undefined>();
	let blackhole: net.Server | undefined;
	const sockets: net.Socket[] = [];

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.OTEL_METRICS_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
	});

	afterEach(async () => {
		try {
			await shutdownProvider();
		} catch {
			// The measured case has already reported its outcome.
		}
		context.disable();
		propagation.disable();
		trace.disable();
		metrics.disable();
		logs.disable();
		// Open connections would keep the test process alive after the file has finished.
		for (const socket of sockets.splice(0)) {
			socket.destroy();
		}
		blackhole?.close();
		blackhole = undefined;
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	async function measure(options: { transport: (typeof TRANSPORTS)[number]; mode: "refused" | "hang"; timeout?: string }): Promise<{ elapsed: number; outcome: string }> {
		const { transport, mode, timeout } = options;
		let port: number;
		if (mode === "hang") {
			blackhole = net.createServer((socket) => {
				sockets.push(socket);
				socket.on("error", () => {});
			});
			port = await listen(blackhole);
		} else {
			port = await refusedPort();
		}
		process.env.OTEL_TRACES_EXPORTER = transport;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
		if (timeout !== undefined) {
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = timeout;
		}
		initProvider();
		getProvider().tracer.startSpan("probe").end();

		const started = performance.now();
		let outcome = "resolved";
		try {
			await shutdownProvider();
		} catch (error) {
			outcome = `rejected: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
		}
		const elapsed = Math.round(performance.now() - started);
		console.log(`MEASURED ${transport} ${mode} timeout=${timeout ?? "default"} -> ${outcome} in ${elapsed} ms`);
		return { elapsed, outcome };
	}

	for (const transport of TRANSPORTS) {
		for (const mode of ["refused", "hang"] as const) {
			it(`${transport}, ${mode}: ends within the exporter timeout (10 s by default) plus a margin`, async () => {
				const { elapsed } = await measure({ transport, mode });

				assert.ok(elapsed < 12_000, `took ${elapsed} ms`);
			});

			it(`${transport}, ${mode}: OTEL_EXPORTER_OTLP_TIMEOUT=500 brings it down to about a second`, async () => {
				const { elapsed } = await measure({ transport, mode, timeout: "500" });

				assert.ok(elapsed < 3_000, `took ${elapsed} ms`);
			});
		}
	}
});
