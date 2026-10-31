/**
 * How log records leave the process: an OTLP exporter receives them in batches and loses none
 * of them when the application emits a burst, the `console` exporter prints each record at
 * once, and the records still waiting in the queue are sent when the provider stops.
 *
 * The collector below is a plain HTTP receiver that decodes the OTLP/JSON body and answers
 * after a delay, like a real collector under load. With one export request per record, the
 * OTLP exporter refuses every request above its limit of concurrent exports and drops the
 * record without a retry, so a burst of 100 records arrived as 10 on the old wiring.
 */

import assert from "node:assert";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getBatchLogRecordProcessorOptions } from "../../src/config.ts";
import { getProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = [
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	// Set in a developer's shell, these would win over the endpoint of the test receiver or turn
	// the JSON body the receiver decodes into protobuf.
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_BLRP_MAX_EXPORT_BATCH_SIZE",
	"OTEL_BLRP_MAX_QUEUE_SIZE",
	"OTEL_BLRP_SCHEDULE_DELAY",
	"OTEL_BLRP_EXPORT_TIMEOUT",
	"OTEL_EXPORTER_OTLP_TIMEOUT",
] as const;

interface Collector {
	origin: string;
	/** Bodies of the log records that reached the collector, in arrival order. */
	bodies: string[];
	/** Number of export requests that reached the collector. */
	requests: () => number;
	close(): Promise<void>;
}

interface OtlpLogsPayload {
	resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: Array<{ body?: { stringValue?: string } }> }> }>;
}

/** A receiver that answers every request after `delayMs`, or never when `delayMs` is `Infinity`. */
async function startCollector(delayMs: number): Promise<Collector> {
	const bodies: string[] = [];
	let requestCount = 0;
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			requestCount++;
			const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpLogsPayload;
			for (const resource of payload.resourceLogs ?? []) {
				for (const scope of resource.scopeLogs ?? []) {
					for (const record of scope.logRecords ?? []) {
						bodies.push(record.body?.stringValue ?? "");
					}
				}
			}
			if (delayMs === Number.POSITIVE_INFINITY) {
				return;
			}
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{}");
			}, delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		bodies,
		requests: () => requestCount,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("log record delivery", () => {
	const saved = new Map<string, string | undefined>();
	let collector: Collector | undefined;
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => {
		warnings.push(warning);
	};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.OTEL_TRACES_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		warnings.length = 0;
		process.on("warning", onWarning);
	});

	afterEach(async () => {
		process.off("warning", onWarning);
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
		await collector?.close();
		collector = undefined;
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	async function useCollector(delayMs: number): Promise<Collector> {
		collector = await startCollector(delayMs);
		process.env.OTEL_LOGS_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;
		return collector;
	}

	function emitBurst(count: number): string[] {
		const { logger } = getProvider();
		const expected: string[] = [];
		for (let i = 0; i < count; i++) {
			const body = `record-${i}`;
			expected.push(body);
			logger.emit({ body });
		}
		return expected;
	}

	it("delivers every record of a burst of 100 emitted in one tick to a slow collector", async () => {
		const target = await useCollector(100);

		const expected = emitBurst(100);
		await shutdownProvider();

		assert.deepStrictEqual([...target.bodies].sort(), [...expected].sort());
	});

	it("delivers a burst larger than one batch in several requests without loss", async () => {
		process.env.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE = "10";
		const target = await useCollector(20);

		const expected = emitBurst(95);
		await shutdownProvider();

		assert.deepStrictEqual([...target.bodies].sort(), [...expected].sort());
		assert.strictEqual(target.requests(), 10, "95 records in batches of 10 are 10 requests");
	});

	it("keeps records in the queue until the delay passes and sends them when the provider stops", async () => {
		process.env.OTEL_BLRP_SCHEDULE_DELAY = "60000";
		const target = await useCollector(0);

		const expected = emitBurst(7);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(target.bodies.length, 0, "nothing is sent before the delay or a shutdown");

		await shutdownProvider();

		assert.deepStrictEqual([...target.bodies].sort(), [...expected].sort());
	});

	it("sends a queued record after the configured delay without waiting for a shutdown", async () => {
		process.env.OTEL_BLRP_SCHEDULE_DELAY = "50";
		const target = await useCollector(0);

		emitBurst(3);
		for (let attempt = 0; attempt < 100 && target.bodies.length < 3; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.strictEqual(target.bodies.length, 3);
	});

	it("drops the records that do not fit into OTEL_BLRP_MAX_QUEUE_SIZE while a batch is on its way", async () => {
		process.env.OTEL_BLRP_MAX_QUEUE_SIZE = "5";
		process.env.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE = "5";
		process.env.OTEL_BLRP_SCHEDULE_DELAY = "60000";
		const target = await useCollector(0);

		// A full batch leaves the queue at once: records 0-4 are on their way, 5-9 fill the
		// queue again, and 10-12 find it full.
		const emitted = emitBurst(13);
		await shutdownProvider();

		assert.deepStrictEqual([...target.bodies].sort(), emitted.slice(0, 10).sort());
	});

	it("bounds the wait of shutdownProvider({ timeout }) when the collector never answers", async () => {
		// Short exporter timeouts only let the cleanup after the test finish quickly.
		process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "1500";
		process.env.OTEL_BLRP_EXPORT_TIMEOUT = "1500";
		const target = await useCollector(Number.POSITIVE_INFINITY);

		emitBurst(2);
		// The exporter would give up with its own error only after 1500 ms; a TimeoutError means
		// the deadline of shutdownProvider() ended the wait.
		await assert.rejects(shutdownProvider({ timeout: 300 }), (error: Error) => error.name === "TimeoutError");

		assert.strictEqual(target.bodies.length, 2, "the queued records were handed to the collector before the deadline");
	});

	it("prints a record of the console exporter at once, without queueing", () => {
		process.env.OTEL_LOGS_EXPORTER = "console";
		process.env.OTEL_BLRP_SCHEDULE_DELAY = "60000";
		const dir = mock.method(console, "dir", () => {});

		getProvider().logger.emit({ body: "printed-now" });

		assert.strictEqual(dir.mock.callCount(), 1, "the record is printed in the same tick as emit()");
	});

	describe("OTEL_BLRP_* variables", () => {
		it("uses the defaults when nothing is set", () => {
			assert.deepStrictEqual(getBatchLogRecordProcessorOptions(), {
				maxExportBatchSize: 512,
				maxQueueSize: 2048,
				scheduledDelayMillis: 1000,
				exportTimeoutMillis: 10000,
			});
		});

		it("reads the four variables", () => {
			process.env.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE = "10";
			process.env.OTEL_BLRP_MAX_QUEUE_SIZE = "20";
			process.env.OTEL_BLRP_SCHEDULE_DELAY = "30";
			process.env.OTEL_BLRP_EXPORT_TIMEOUT = "40";

			assert.deepStrictEqual(getBatchLogRecordProcessorOptions(), {
				maxExportBatchSize: 10,
				maxQueueSize: 20,
				scheduledDelayMillis: 30,
				exportTimeoutMillis: 40,
			});
		});

		const invalid: Array<{ variable: (typeof ENV_KEYS)[number]; bad: string; field: string; fallback: number }> = [
			{ variable: "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", bad: "abc", field: "maxExportBatchSize", fallback: 512 },
			{ variable: "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", bad: "0", field: "maxExportBatchSize", fallback: 512 },
			{ variable: "OTEL_BLRP_MAX_QUEUE_SIZE", bad: "0", field: "maxQueueSize", fallback: 2048 },
			{ variable: "OTEL_BLRP_SCHEDULE_DELAY", bad: "-5", field: "scheduledDelayMillis", fallback: 1000 },
			{ variable: "OTEL_BLRP_EXPORT_TIMEOUT", bad: "10s", field: "exportTimeoutMillis", fallback: 10000 },
		];
		for (const { variable, bad, field, fallback } of invalid) {
			it(`${variable}=${bad} warns naming the variable and uses the default ${fallback}`, async () => {
				process.env[variable] = bad;

				const options = getBatchLogRecordProcessorOptions();

				assert.strictEqual(options[field as keyof typeof options], fallback);
				await new Promise((resolve) => setImmediate(resolve));
				const about = warnings.filter((warning) => warning.message.includes(variable));
				assert.strictEqual(about.length, 1);
				assert.ok(about[0]?.message.includes(`"${bad}"`));
			});
		}

		it("accepts 0 for the two durations", () => {
			process.env.OTEL_BLRP_SCHEDULE_DELAY = "0";
			process.env.OTEL_BLRP_EXPORT_TIMEOUT = "0";

			const options = getBatchLogRecordProcessorOptions();

			assert.strictEqual(options.scheduledDelayMillis, 0);
			assert.strictEqual(options.exportTimeoutMillis, 0);
			assert.strictEqual(warnings.length, 0);
		});
	});
});
