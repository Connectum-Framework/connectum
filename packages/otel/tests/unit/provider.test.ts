/**
 * Provider module tests
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { getProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

// Disable real exporters for tests
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

describe("provider", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	describe("getProvider", () => {
		it("should lazily create provider on first call", () => {
			const provider = getProvider();

			assert.ok(provider);
			assert.ok(provider.tracer);
			assert.ok(provider.meter);
			assert.ok(provider.logger);
		});

		it("should return same instance on subsequent calls", () => {
			const first = getProvider();
			const second = getProvider();

			assert.strictEqual(first, second);
		});
	});

	describe("initProvider", () => {
		it("should throw if called twice without shutdown", () => {
			initProvider();

			assert.throws(
				() => initProvider(),
				{ message: /already initialized/i },
			);
		});
	});

	describe("shutdownProvider", () => {
		it("should allow re-initialization after shutdown", async () => {
			getProvider();
			await shutdownProvider();

			// Should not throw
			initProvider();
			const provider = getProvider();
			assert.ok(provider);
		});

		it("should be no-op when provider not initialized", async () => {
			// Should not throw
			await shutdownProvider();
		});
	});
});
