/**
 * `initProvider({ settings })` checks the exporter names passed in code.
 *
 * A name that matched no exporter used to fall into the console branch without a
 * message, so a typo wrote spans to standard output while the intended exporter never
 * ran. A value in code is the programmer's, so unlike an environment variable it fails
 * loudly and at once.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ProviderOptions } from "../../src/provider.ts";
import { getProvider, hasProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"] as const;

describe("initProvider settings validation", () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			process.env[key] = "none";
		}
	});

	afterEach(async () => {
		mock.restoreAll();
		await shutdownProvider();
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

	// A value the type system would reject; the check exists for callers without it.
	const settings = (value: unknown) => value as NonNullable<ProviderOptions["settings"]>;

	for (const signal of ["traces", "metrics", "logs"] as const) {
		it(`throws TypeError for an unknown exporter on ${signal}, naming the signal, the value and the accepted values`, () => {
			assert.throws(
				() => initProvider({ settings: settings({ [signal]: "bogus" }) }),
				(error: unknown) => {
					assert.ok(error instanceof TypeError);
					assert.ok(error.message.includes(`settings.${signal}`), error.message);
					assert.ok(error.message.includes('"bogus"'), error.message);
					for (const accepted of ["console", "otlp/http", "otlp/http-protobuf", "otlp/grpc", "none"]) {
						assert.ok(error.message.includes(accepted), `${accepted} is listed: ${error.message}`);
					}
					return true;
				},
			);
		});
	}

	it("throws TypeError for the bare `otlp` value, which only the environment variables accept", () => {
		assert.throws(() => initProvider({ settings: settings({ traces: "otlp" }) }), TypeError);
	});

	it("throws TypeError for a signal that does not exist", () => {
		assert.throws(
			() => initProvider({ settings: settings({ trace: "none" }) }),
			(error: unknown) => error instanceof TypeError && error.message.includes('"trace"'),
		);
	});

	it("throws TypeError for a value that is not a string", () => {
		assert.throws(() => initProvider({ settings: settings({ traces: 1 }) }), TypeError);
	});

	it("creates nothing when it throws: no provider, and a later call with valid settings works", () => {
		assert.throws(() => initProvider({ settings: settings({ traces: "bogus" }) }), TypeError);
		assert.strictEqual(hasProvider(), false);

		initProvider({ settings: { traces: "none" } });

		assert.strictEqual(hasProvider(), true);
	});

	it("accepts every exporter name the type allows, and leaves a missing or undefined entry to the environment", async () => {
		for (const value of ["console", "otlp/http", "otlp/http-protobuf", "otlp/grpc", "none"] as const) {
			assert.doesNotThrow(() => initProvider({ settings: { traces: value, metrics: "none", logs: "none" } }), value);
			// No span was recorded, so stopping an OTLP exporter has nothing to deliver.
			await shutdownProvider();
		}
		assert.doesNotThrow(() => initProvider({ settings: settings({ traces: undefined }) }));
		assert.doesNotThrow(() => initProvider({ settings: {} }));
		assert.doesNotThrow(() => initProvider());
	});

	it("does not touch an already created provider when the second call is invalid: the first call wins as before", () => {
		initProvider({ settings: { traces: "none" } });
		const first = getProvider();

		// Validation does not depend on whether a provider exists yet.
		assert.throws(() => initProvider({ settings: settings({ traces: "bogus" }) }), TypeError);

		assert.strictEqual(getProvider(), first);
	});
});
