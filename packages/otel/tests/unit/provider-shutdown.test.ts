/**
 * What `shutdownProvider()` promises when it is called more than once at the same time, and
 * how a caller bounds the wait.
 *
 * Two independent stop paths (a signal handler and a framework hook, for example) may both
 * call it. The second used to see no provider and return at once, so a hook that exits the
 * process could run before the first call had flushed the last batch. The collector in these
 * tests holds its answer until the test releases it, so the order of events is controlled
 * by the test and no assertion depends on elapsed milliseconds.
 */

import assert from "node:assert";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, hasProvider, initProvider, shutdownProvider } from "../../src/provider.ts";

const ENV_KEYS = ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TIMEOUT"] as const;

interface HoldingCollector {
	origin: string;
	/** Resolves when the first export request has reached the collector. */
	arrived: Promise<void>;
	/** Answers every request that is waiting. */
	release(): void;
	close(): Promise<void>;
}

/** A collector that accepts each request and answers only when released (or never). */
async function startHoldingCollector(): Promise<HoldingCollector> {
	const held: ServerResponse[] = [];
	let arrive: () => void = () => {};
	const arrived = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	const server: Server = createServer((req: IncomingMessage, res) => {
		req.resume();
		req.on("end", () => {
			held.push(res);
			arrive();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		arrived,
		release() {
			for (const res of held.splice(0)) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{}");
			}
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Lets pending promise callbacks and I/O callbacks run, which is all "has it settled yet" needs. */
async function turn(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** Reports whether a promise has settled without waiting for it. */
function track<T>(promise: Promise<T>): { readonly settled: boolean; readonly promise: Promise<T> } {
	const state = { settled: false, promise };
	promise.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		},
	);
	return state;
}

describe("shutdownProvider", () => {
	const saved = new Map<string, string | undefined>();
	let collector: HoldingCollector | undefined;

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.OTEL_METRICS_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		collector = await startHoldingCollector();
		process.env.OTEL_TRACES_EXPORTER = "otlp/http";
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;
	});

	afterEach(async () => {
		collector?.release();
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

	/** Starts the provider and leaves one span queued for export. */
	function recordSpan(): void {
		initProvider();
		getProvider().tracer.startSpan("probe").end();
	}

	describe("called while another call is stopping the provider", () => {
		it("does not return before the flush has finished", async () => {
			recordSpan();
			const first = track(shutdownProvider());
			await collector?.arrived;
			const second = track(shutdownProvider());

			await turn();
			assert.strictEqual(first.settled, false, "the collector is still holding the export");
			assert.strictEqual(second.settled, false, "the second call must wait for the flush the first one started");

			collector?.release();
			await Promise.all([first.promise, second.promise]);
		});

		it("rejects with the same error as the call that started the stop", async () => {
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "300";
			recordSpan();
			const first = shutdownProvider();
			const second = shutdownProvider();

			// The collector never answers, so the exporter gives up after its timeout.
			const [one, other] = await Promise.allSettled([first, second]);

			assert.strictEqual(one.status, "rejected");
			assert.strictEqual(other.status, "rejected");
			assert.strictEqual((other as PromiseRejectedResult).reason, (one as PromiseRejectedResult).reason);
		});

		it("is a no-op again once the stop has settled", async () => {
			recordSpan();
			const first = shutdownProvider();
			const second = shutdownProvider();
			await collector?.arrived;
			collector?.release();
			await Promise.all([first, second]);

			await assert.doesNotReject(shutdownProvider());
			assert.strictEqual(hasProvider(), false);
		});

		it("lets a new provider be created while the old one is still being stopped", async () => {
			recordSpan();
			const stopping = shutdownProvider();
			await collector?.arrived;

			const fresh = getProvider();
			collector?.release();
			await stopping;

			assert.strictEqual(getProvider(), fresh, "the shutdown that finished later does not remove the provider created meanwhile");
		});
	});

	describe("with a timeout", () => {
		it("rejects with TimeoutError when the collector does not answer, and releases the provider", async () => {
			// Bounds what the abandoned export may still do in the background after the test.
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "2000";
			recordSpan();
			const stopped = getProvider();

			await assert.rejects(shutdownProvider({ timeout: 50 }), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.strictEqual(error.name, "TimeoutError");
				assert.ok(error.message.includes("50 ms"), error.message);
				return true;
			});

			assert.strictEqual(hasProvider(), false, "the provider is released although the flush did not finish");
			initProvider();
			assert.notStrictEqual(getProvider(), stopped);
		});

		it("resolves normally when the flush finishes in time", async () => {
			recordSpan();
			const done = shutdownProvider({ timeout: 60_000 });
			await collector?.arrived;
			collector?.release();

			await assert.doesNotReject(done);
		});

		it("applies to the caller that passed it, not to a concurrent caller without one", async () => {
			process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "2000";
			recordSpan();
			const patient = track(shutdownProvider());
			await collector?.arrived;

			await assert.rejects(shutdownProvider({ timeout: 20 }), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
			await turn();
			assert.strictEqual(patient.settled, false, "the first call is still waiting for the collector");

			collector?.release();
			await assert.doesNotReject(patient.promise);
		});

		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000"]) {
			it(`rejects with TypeError for timeout ${String(bad)} and does not stop the provider`, async () => {
				recordSpan();

				await assert.rejects(shutdownProvider({ timeout: bad as number }), TypeError);

				assert.strictEqual(hasProvider(), true);
			});
		}

		it("without the option the wait is whatever the exporter needs: no hidden deadline", async () => {
			recordSpan();
			const unbounded = track(shutdownProvider());
			await collector?.arrived;

			// Well beyond any plausible default deadline of a few turns of the event loop.
			await turn();
			assert.strictEqual(unbounded.settled, false);

			collector?.release();
			await unbounded.promise;
		});
	});
});
