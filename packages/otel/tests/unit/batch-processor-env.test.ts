/**
 * Invalid OTEL_BSP_* values: a warning and the default, never an exception.
 *
 * The provider is created lazily on the first traced call, so an exception from
 * reading these variables would surface inside the user's own call.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { getBatchSpanProcessorOptions } from "../../src/config.ts";
import { getProvider, shutdownProvider } from "../../src/provider.ts";

const BSP_KEYS = ["OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "OTEL_BSP_MAX_QUEUE_SIZE", "OTEL_BSP_SCHEDULE_DELAY", "OTEL_BSP_EXPORT_TIMEOUT"] as const;
const ENV_KEYS = [...BSP_KEYS, "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"] as const;

describe("batch span processor environment", () => {
	const saved = new Map<string, string | undefined>();
	let warnings: Error[] = [];
	const onWarning = (warning: Error) => {
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

	afterEach(async () => {
		process.off("warning", onWarning);
		await shutdownProvider();
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	/** Warnings are delivered on a later tick; wait for it before reading them. */
	async function warningsAbout(variable: string): Promise<Error[]> {
		await new Promise((resolve) => setImmediate(resolve));
		return warnings.filter((warning) => warning.message.includes(variable));
	}

	const cases: Array<{ variable: (typeof BSP_KEYS)[number]; bad: string; field: string; fallback: number }> = [
		{ variable: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", bad: "abc", field: "maxExportBatchSize", fallback: 100 },
		{ variable: "OTEL_BSP_MAX_QUEUE_SIZE", bad: "abc", field: "maxQueueSize", fallback: 1000 },
		{ variable: "OTEL_BSP_SCHEDULE_DELAY", bad: "-5", field: "scheduledDelayMillis", fallback: 1000 },
		{ variable: "OTEL_BSP_EXPORT_TIMEOUT", bad: "10s", field: "exportTimeoutMillis", fallback: 10000 },
		// A queue of size 0 drops every span silently and a batch of size 0 exhausts the heap, so
		// zero is invalid for these two even though it is an integer.
		{ variable: "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", bad: "0", field: "maxExportBatchSize", fallback: 100 },
		{ variable: "OTEL_BSP_MAX_QUEUE_SIZE", bad: "0", field: "maxQueueSize", fallback: 1000 },
	];

	for (const { variable, bad, field, fallback } of cases) {
		it(`${variable}=${bad} warns naming the variable and the value and uses the default ${fallback}`, async () => {
			process.env[variable] = bad;

			const options = getBatchSpanProcessorOptions();

			assert.strictEqual(options[field as keyof typeof options], fallback);
			const about = await warningsAbout(variable);
			assert.strictEqual(about.length, 1);
			assert.ok(about[0]?.message.includes(`"${bad}"`), `warning should quote the rejected value: ${about[0]?.message}`);
		});
	}

	for (const bad of ["1.5", "10ms", " ", "NaN"]) {
		it(`rejects the non-integer value ${JSON.stringify(bad)} with a warning and the default`, async () => {
			process.env.OTEL_BSP_MAX_QUEUE_SIZE = bad;

			assert.strictEqual(getBatchSpanProcessorOptions().maxQueueSize, 1000);
			assert.strictEqual((await warningsAbout("OTEL_BSP_MAX_QUEUE_SIZE")).length, 1);
		});
	}

	it("accepts 0 for the two durations, which the span processor handles", async () => {
		process.env.OTEL_BSP_SCHEDULE_DELAY = "0";
		process.env.OTEL_BSP_EXPORT_TIMEOUT = "0";

		const options = getBatchSpanProcessorOptions();

		assert.strictEqual(options.scheduledDelayMillis, 0);
		assert.strictEqual(options.exportTimeoutMillis, 0);
		assert.strictEqual((await warningsAbout("OTEL_BSP_")).length, 0);
	});

	it("still exports spans when the queue size variable is 0, because the default replaces it", async () => {
		process.env.OTEL_BSP_MAX_QUEUE_SIZE = "0";
		const exporter = new InMemorySpanExporter();
		const processor = new BatchSpanProcessor(exporter, getBatchSpanProcessorOptions());
		const provider = new BasicTracerProvider({ spanProcessors: [processor] });

		for (let i = 0; i < 5; i++) {
			provider.getTracer("t").startSpan(`s${i}`).end();
		}
		await provider.forceFlush();
		// Read before shutdown: shutting the in-memory exporter down clears what it holds.
		const exported = exporter.getFinishedSpans().length;
		await provider.shutdown();

		assert.strictEqual(exported, 5, "with a queue of size 0 the processor drops all five");
	});

	it("keeps the valid variables when another one is invalid", async () => {
		process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = "50";
		process.env.OTEL_BSP_EXPORT_TIMEOUT = "abc";

		const options = getBatchSpanProcessorOptions();

		assert.strictEqual(options.maxExportBatchSize, 50);
		assert.strictEqual(options.exportTimeoutMillis, 10000);
		assert.strictEqual((await warningsAbout("OTEL_BSP_MAX_EXPORT_BATCH_SIZE")).length, 0);
	});

	it("does not warn when the variables are valid or unset", async () => {
		process.env.OTEL_BSP_MAX_QUEUE_SIZE = "500";

		getBatchSpanProcessorOptions();

		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(
			warnings.filter((warning) => warning.message.includes("OTEL_BSP_")),
			[],
		);
	});

	it("creates the provider with a console trace exporter despite an invalid variable", () => {
		process.env.OTEL_TRACES_EXPORTER = "console";
		process.env.OTEL_METRICS_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_BSP_MAX_QUEUE_SIZE = "abc";

		assert.doesNotThrow(() => getProvider());
	});
});
