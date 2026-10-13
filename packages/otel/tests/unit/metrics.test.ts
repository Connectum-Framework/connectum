/**
 * Metrics module tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Meter } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { createRpcClientMetrics, createRpcServerMetrics, RPC_DURATION_BUCKETS } from "../../src/metrics.ts";

interface HistogramCall {
	name: string;
	options: unknown;
}

function createMockMeter(): { meter: Meter; calls: HistogramCall[] } {
	const calls: HistogramCall[] = [];
	const meter = {
		createHistogram(name: string, options?: unknown) {
			calls.push({ name, options });
			return { record() {} };
		},
		createCounter() {
			return {};
		},
		createUpDownCounter() {
			return {};
		},
		createObservableGauge() {
			return {};
		},
		createObservableCounter() {
			return {};
		},
		createObservableUpDownCounter() {
			return {};
		},
		createGauge() {
			return {};
		},
		addBatchObservableCallback() {},
		removeBatchObservableCallback() {},
	} as unknown as Meter;

	return { meter, calls };
}

describe("metrics", () => {
	describe("createRpcServerMetrics", () => {
		it("should return an object with 3 metric fields", () => {
			const { meter } = createMockMeter();

			const metrics = createRpcServerMetrics(meter);

			assert.ok(metrics.callDuration, "callDuration should be defined");
			assert.ok(metrics.requestSize, "requestSize should be defined");
			assert.ok(metrics.responseSize, "responseSize should be defined");
			assert.strictEqual(
				Object.keys(metrics).length,
				3,
				"should have exactly 3 fields",
			);
		});

		it("should call meter.createHistogram 3 times", () => {
			const { meter, calls } = createMockMeter();

			createRpcServerMetrics(meter);

			assert.strictEqual(calls.length, 3, "should create 3 histograms");
		});

		it("should create rpc.server.call.duration histogram with unit 's'", () => {
			const { meter, calls } = createMockMeter();

			createRpcServerMetrics(meter);

			const durationCall = calls.find(
				(c) => c.name === "rpc.server.call.duration",
			);
			assert.ok(durationCall, "should create rpc.server.call.duration");
			assert.strictEqual(
				(durationCall.options as { unit: string }).unit,
				"s",
				"unit should be 's'",
			);
		});

		it("should create rpc.server.request.size histogram with unit 'By'", () => {
			const { meter, calls } = createMockMeter();

			createRpcServerMetrics(meter);

			const requestCall = calls.find(
				(c) => c.name === "rpc.server.request.size",
			);
			assert.ok(requestCall, "should create rpc.server.request.size");
			assert.strictEqual(
				(requestCall.options as { unit: string }).unit,
				"By",
				"unit should be 'By'",
			);
		});

		it("should create rpc.server.response.size histogram with unit 'By'", () => {
			const { meter, calls } = createMockMeter();

			createRpcServerMetrics(meter);

			const responseCall = calls.find(
				(c) => c.name === "rpc.server.response.size",
			);
			assert.ok(responseCall, "should create rpc.server.response.size");
			assert.strictEqual(
				(responseCall.options as { unit: string }).unit,
				"By",
				"unit should be 'By'",
			);
		});
	});
});

describe("call-duration histogram boundaries on a real SDK", () => {
	// The OpenTelemetry RPC metrics specification lists exactly these boundaries (seconds) for
	// rpc.server.call.duration and rpc.client.call.duration. The list is spelled out here on purpose:
	// importing the production constant would make the test agree with itself.
	const SPEC_BOUNDARIES = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

	async function exportHistogram(
		create: (meter: Meter) => { callDuration: { record(value: number): void } },
		name: string,
		value: number,
	) {
		const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
		const provider = new MeterProvider({ readers: [reader] });
		try {
			create(provider.getMeter("boundaries-test")).callDuration.record(value);
			await provider.forceFlush();
			const metric = exporter
				.getMetrics()
				.flatMap((r) => r.scopeMetrics)
				.flatMap((s) => s.metrics)
				.find((m) => m.descriptor.name === name);
			assert.ok(metric, `${name} should be exported`);
			return metric.dataPoints[0]?.value as { buckets: { boundaries: number[]; counts: number[] } };
		} finally {
			await provider.shutdown();
		}
	}

	it("exports rpc.server.call.duration with the specification boundaries and places 0.03 s in (0.025, 0.05]", async () => {
		const histogram = await exportHistogram(createRpcServerMetrics, "rpc.server.call.duration", 0.03);

		assert.deepStrictEqual(histogram.buckets.boundaries, SPEC_BOUNDARIES);
		const index = histogram.buckets.counts.findIndex((c) => c === 1);
		assert.strictEqual(SPEC_BOUNDARIES[index - 1], 0.025);
		assert.strictEqual(SPEC_BOUNDARIES[index], 0.05);
	});

	it("exports rpc.client.call.duration with the specification boundaries and places 0.4 s in (0.25, 0.5]", async () => {
		const histogram = await exportHistogram(createRpcClientMetrics, "rpc.client.call.duration", 0.4);

		assert.deepStrictEqual(histogram.buckets.boundaries, SPEC_BOUNDARIES);
		const index = histogram.buckets.counts.findIndex((c) => c === 1);
		assert.strictEqual(SPEC_BOUNDARIES[index - 1], 0.25);
		assert.strictEqual(SPEC_BOUNDARIES[index], 0.5);
	});

	it("exposes RPC_DURATION_BUCKETS equal to the specification list", () => {
		assert.deepStrictEqual([...RPC_DURATION_BUCKETS], SPEC_BOUNDARIES);
	});
});
