/**
 * Metrics module tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Meter } from "@opentelemetry/api";
import { createRpcServerMetrics } from "../../src/metrics.ts";

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
