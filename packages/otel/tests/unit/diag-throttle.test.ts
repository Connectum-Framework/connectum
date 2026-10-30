/**
 * The diagnostics logger the provider installs.
 *
 * An OTLP exporter reports every failed export through the OpenTelemetry
 * diagnostics channel. With a collector that is down, that is one report per batch
 * of spans, one per exported log record and one per metric interval, each a
 * multi-line stack. The logger prints a given message once and then holds identical
 * ones back for a window, so a dead collector costs a few lines a minute.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DiagLogger } from "@opentelemetry/api";
import { createThrottledDiagLogger } from "../../src/diagThrottle.ts";

function recordingTarget(): { target: DiagLogger; calls: Array<{ level: string; args: unknown[] }> } {
	const calls: Array<{ level: string; args: unknown[] }> = [];
	const record =
		(level: string) =>
		(...args: unknown[]) => {
			calls.push({ level, args });
		};
	return {
		calls,
		target: { error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug"), verbose: record("verbose") },
	};
}

describe("createThrottledDiagLogger", () => {
	it("prints the first error and holds identical ones back inside the window", () => {
		const { target, calls } = recordingTarget();
		let now = 0;
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => now });

		for (let i = 0; i < 100; i++) {
			logger.error("export failed: ECONNREFUSED");
			now += 100;
		}

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0], { level: "error", args: ["export failed: ECONNREFUSED"] });
	});

	it("prints the message again once the window has passed, and says how many were held back", () => {
		const { target, calls } = recordingTarget();
		let now = 0;
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => now });

		logger.error("export failed");
		now = 1_000;
		logger.error("export failed");
		logger.error("export failed");
		now = 60_000;
		logger.error("export failed");

		assert.strictEqual(calls.length, 2);
		assert.deepStrictEqual(calls[1]?.args, ["export failed (repeated 2 more times in the last 60 s)"]);
	});

	it("keeps distinct messages apart", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		logger.error("traces export failed");
		logger.error("metrics export failed");
		logger.error("traces export failed");

		assert.deepStrictEqual(
			calls.map((call) => call.args[0]),
			["traces export failed", "metrics export failed"],
		);
	});

	it("passes the extra arguments of a printed error through", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });
		const detail = { code: "ECONNREFUSED" };

		logger.error("export failed", detail);

		assert.deepStrictEqual(calls[0]?.args, ["export failed", detail]);
	});

	it("forwards the other levels untouched", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		logger.warn("w");
		logger.warn("w");
		logger.info("i");
		logger.debug("d");
		logger.verbose("v");

		assert.deepStrictEqual(
			calls.map((call) => call.level),
			["warn", "warn", "info", "debug", "verbose"],
		);
	});

	it("says 'time' for a single held-back copy", () => {
		const { target, calls } = recordingTarget();
		let now = 0;
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => now });

		logger.error("export failed");
		logger.error("export failed");
		now = 60_000;
		logger.error("export failed");

		assert.deepStrictEqual(calls[1]?.args, ["export failed (repeated 1 more time in the last 60 s)"]);
	});

	it("keeps working when far more distinct messages arrive than it tracks", () => {
		const { target, calls } = recordingTarget();
		let now = 0;
		const logger = createThrottledDiagLogger({ target, windowMs: 1_000, now: () => now });

		for (let i = 0; i < 1_000; i++) {
			logger.error(`failure ${i}`);
			now += 10;
		}
		now += 5_000;
		logger.error("failure 999");

		assert.strictEqual(calls.length, 1_001);
	});

	it("makes room for a new message when every tracked one is still inside its window", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		for (let i = 0; i < 500; i++) {
			logger.error(`failure ${i}`);
		}
		// The oldest entries were evicted to stay bounded, so the first message prints again; the newest is still held back.
		logger.error("failure 0");
		logger.error("failure 499");

		assert.strictEqual(calls.length, 501);
		assert.strictEqual(calls[500]?.args[0], "failure 0");
	});

	it("treats the same message with a different cause as a different error", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		logger.error("PeriodicExportingMetricReader: metrics collection errors", new Error("callback A broke"));
		logger.error("PeriodicExportingMetricReader: metrics collection errors", new Error("callback B broke"));
		logger.error("PeriodicExportingMetricReader: metrics collection errors", new Error("callback A broke"));

		assert.strictEqual(calls.length, 2);
	});

	it("tells errors with the same message apart by their cause", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		logger.error("callback failed", new Error("fetch failed", { cause: new Error("ECONNREFUSED") }));
		logger.error("callback failed", new Error("fetch failed", { cause: new Error("ETIMEDOUT") }));
		logger.error("callback failed", new Error("fetch failed", { cause: new Error("ECONNREFUSED") }));

		assert.strictEqual(calls.length, 2);
	});

	it("tells plain-object arguments apart by their content", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });

		logger.error("batch callback registration failed", [{ name: "orders" }]);
		logger.error("batch callback registration failed", [{ name: "payments" }]);
		logger.error("batch callback registration failed", [{ name: "orders" }]);

		assert.strictEqual(calls.length, 2);
	});

	it("reaches the name of an instrument nested in an array of instruments", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });
		const instrument = (name: string) => ({ _descriptor: { name, unit: "" }, _meter: {} });

		logger.error("batch callback registration failed", [instrument("orders_total")]);
		logger.error("batch callback registration failed", [instrument("payments_total")]);

		assert.strictEqual(calls.length, 2);
	});

	it("reports an argument whose toString() throws instead of failing", () => {
		const { target, calls } = recordingTarget();
		const logger = createThrottledDiagLogger({ target, windowMs: 60_000, now: () => 0 });
		const hostile = {
			toString(): string {
				throw new Error("no text");
			},
		};

		assert.doesNotThrow(() => logger.error("export failed", hostile));
		assert.strictEqual(calls.length, 1);
	});
});
