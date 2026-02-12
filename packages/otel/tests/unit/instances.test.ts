/**
 * Instance exports tests (tracer, logger, meter)
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { getLogger } from "../../src/logger.ts";
import { getMeter } from "../../src/meter.ts";
import { shutdownProvider } from "../../src/provider.ts";
import { getTracer } from "../../src/tracer.ts";

// Disable real exporters for tests
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

describe("tracer", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	it("should export tracer instance", () => {
		const tracer = getTracer();
		assert.ok(tracer);
		assert.ok(typeof tracer === "object");
	});

	it("should have startActiveSpan method", () => {
		const tracer = getTracer();
		assert.ok(typeof tracer.startActiveSpan === "function");
	});

	it("should have startSpan method", () => {
		const tracer = getTracer();
		assert.ok(typeof tracer.startSpan === "function");
	});
});

describe("logger", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	it("should export logger instance", () => {
		const logger = getLogger("test");
		assert.ok(logger);
		assert.ok(typeof logger === "object");
	});

	it("should have emit method", () => {
		const logger = getLogger("test");
		assert.ok(typeof logger.emit === "function");
	});

	it("should have convenience methods", () => {
		const logger = getLogger("test");
		assert.ok(typeof logger.info === "function");
		assert.ok(typeof logger.warn === "function");
		assert.ok(typeof logger.error === "function");
		assert.ok(typeof logger.debug === "function");
	});
});

describe("meter", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	it("should export meter instance", () => {
		const meter = getMeter();
		assert.ok(meter);
		assert.ok(typeof meter === "object");
	});

	it("should have createCounter method", () => {
		const meter = getMeter();
		assert.ok(typeof meter.createCounter === "function");
	});

	it("should have createHistogram method", () => {
		const meter = getMeter();
		assert.ok(typeof meter.createHistogram === "function");
	});

	it("should have createUpDownCounter method", () => {
		const meter = getMeter();
		assert.ok(typeof meter.createUpDownCounter === "function");
	});

	it("should have createObservableGauge method", () => {
		const meter = getMeter();
		assert.ok(typeof meter.createObservableGauge === "function");
	});
});
