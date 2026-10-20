/**
 * Telemetry must not change the outcome of the observed call.
 *
 * Covers: a failure while recording arguments never stops the wrapped function; a
 * thrown value of any kind (including null, undefined, 0 and "") is reported as a
 * failure and reaches the caller unchanged.
 */

process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";
import { wrapAsyncIterable } from "../../src/shared.ts";
import { traceAll } from "../../src/traceAll.ts";
import { traced } from "../../src/traced.ts";
import { type Observed, observe, onlySpan, pointAttributes } from "./observe.ts";

/** Values a caller may throw that are falsy, or that the old code could not read `.message` from. */
const FALSY_THROWN: Array<{ label: string; value: unknown }> = [
	{ label: "null", value: null },
	{ label: "undefined", value: undefined },
	{ label: "0", value: 0 },
	{ label: "the empty string", value: "" },
];

/** What a call produced: its return value, or the exact value it threw. */
type Outcome = { kind: "returned"; value: unknown } | { kind: "threw"; value: unknown };

async function outcomeOf(body: () => unknown): Promise<Outcome> {
	try {
		return { kind: "returned", value: await body() };
	} catch (error) {
		return { kind: "threw", value: error };
	}
}

function syncOutcomeOf(body: () => unknown): Outcome {
	try {
		return { kind: "returned", value: body() };
	} catch (error) {
		return { kind: "threw", value: error };
	}
}

/** Observes a body and returns the single span it produced. */
async function observedSpan(body: () => Promise<void>): Promise<{ observed: Observed; span: ReturnType<typeof onlySpan> }> {
	const observed = await observe(body);
	return { observed, span: onlySpan(observed) };
}

function exceptionEvents(span: ReturnType<typeof onlySpan>) {
	return span.events.filter((event) => event.name === "exception");
}

describe("telemetry never changes the outcome of a call", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	describe("argument recording", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const unserializable: Array<{ label: string; value: unknown }> = [
			{ label: "a BigInt", value: 10n },
			{ label: "a circular object", value: circular },
		];

		for (const { label, value } of unserializable) {
			it(`runs a traced function and returns its result when an argument is ${label}`, async () => {
				let calls = 0;
				const fn = traced(
					(_arg: unknown) => {
						calls++;
						return "result";
					},
					{ name: "fn", recordArgs: true },
				);

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(syncOutcomeOf(() => fn(value)), { kind: "returned", value: "result" });
				});

				assert.strictEqual(calls, 1);
				assert.strictEqual("function.args" in span.attributes, false);
				assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
			});

			it(`runs a traced async function and returns its result when an argument is ${label}`, async () => {
				let calls = 0;
				const fn = traced(
					async (_arg: unknown) => {
						calls++;
						return "result";
					},
					{ name: "fn", recordArgs: true },
				);

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(await outcomeOf(() => fn(value)), { kind: "returned", value: "result" });
				});

				assert.strictEqual(calls, 1);
				assert.strictEqual("function.args" in span.attributes, false);
			});

			it(`runs a traceAll method and returns its result when an argument is ${label}`, async () => {
				let calls = 0;
				const service = traceAll(
					{
						find(_arg: unknown) {
							calls++;
							return "result";
						},
					},
					{ prefix: "Svc", recordArgs: true },
				);

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(syncOutcomeOf(() => service.find(value)), { kind: "returned", value: "result" });
				});

				assert.strictEqual(calls, 1);
				assert.strictEqual("function.args" in span.attributes, false);
			});
		}

		it("runs a traced function when the argument filter throws", async () => {
			let calls = 0;
			const fn = traced(
				(_arg: string) => {
					calls++;
					return "result";
				},
				{
					name: "fn",
					recordArgs: true,
					argsFilter: () => {
						throw new Error("filter bug");
					},
				},
			);

			const { span } = await observedSpan(async () => {
				assert.deepStrictEqual(syncOutcomeOf(() => fn("x")), { kind: "returned", value: "result" });
			});

			assert.strictEqual(calls, 1);
			assert.strictEqual("function.args" in span.attributes, false);
		});

		it("runs a traceAll method when the argument filter throws", async () => {
			let calls = 0;
			const service = traceAll(
				{
					find(_arg: string) {
						calls++;
						return "result";
					},
				},
				{
					prefix: "Svc",
					recordArgs: true,
					argsFilter: () => {
						throw new Error("filter bug");
					},
				},
			);

			const { span } = await observedSpan(async () => {
				assert.deepStrictEqual(syncOutcomeOf(() => service.find("x")), { kind: "returned", value: "result" });
			});

			assert.strictEqual(calls, 1);
			assert.strictEqual("function.args" in span.attributes, false);
		});

		it("still records serializable arguments as JSON", async () => {
			const fn = traced((_a: number, _b: string) => 1, { name: "fn", recordArgs: true });

			const { span } = await observedSpan(async () => {
				fn(7, "seven");
			});

			assert.strictEqual(span.attributes["function.args"], '[7,"seven"]');
		});

		it("keeps the function's own error when the argument is unserializable and the function throws", async () => {
			const failure = new Error("function failed");
			const fn = traced(
				(_arg: unknown) => {
					throw failure;
				},
				{ name: "fn", recordArgs: true },
			);

			const { span } = await observedSpan(async () => {
				const outcome = syncOutcomeOf(() => fn(10n));
				assert.deepStrictEqual(outcome, { kind: "threw", value: failure });
			});

			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
			assert.strictEqual(span.status.message, "function failed");
		});
	});

	describe("thrown values of any kind", () => {
		for (const { label, value } of FALSY_THROWN) {
			it(`traced: a synchronous throw of ${label} reaches the caller and marks the span as failed`, async () => {
				const fn = traced(
					() => {
						throw value;
					},
					{ name: "fn" },
				);

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(syncOutcomeOf(() => fn()), { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
			});

			it(`traced: a rejection with ${label} reaches the caller and marks the span as failed`, async () => {
				const fn = traced(async () => Promise.reject(value), { name: "fn" });

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(await outcomeOf(() => fn()), { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
			});

			it(`traceAll: a synchronous throw of ${label} reaches the caller and marks the span as failed`, async () => {
				const service = traceAll(
					{
						run(): void {
							throw value;
						},
					},
					{ prefix: "Svc" },
				);

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(syncOutcomeOf(() => service.run()), { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
			});

			it(`traceAll: a rejection with ${label} reaches the caller and marks the span as failed`, async () => {
				const service = traceAll({ run: async () => Promise.reject(value) }, { prefix: "Svc" });

				const { span } = await observedSpan(async () => {
					assert.deepStrictEqual(await outcomeOf(() => service.run()), { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
			});

			it(`server interceptor: a handler failing with ${label} reaches the caller, the span is ERROR and the metric carries error.type UNKNOWN`, async () => {
				const next = (async () => {
					throw value;
				}) as never;
				const handler = createOtelInterceptor()(next);

				const { observed, span } = await observedSpan(async () => {
					const outcome = await outcomeOf(() => handler(createMockRequest({ service: "acme.v1.Svc", method: "Run" })));
					assert.deepStrictEqual(outcome, { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
				assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "UNKNOWN");
				const points = pointAttributes(observed, semconv.METRIC_RPC_SERVER_CALL_DURATION);
				assert.strictEqual(points.length, 1);
				assert.strictEqual(points[0]?.[semconv.ATTR_ERROR_TYPE], "UNKNOWN");
			});

			it(`client interceptor: a call failing with ${label} reaches the caller, the span is ERROR and the metric carries error.type UNKNOWN`, async () => {
				const next = (async () => {
					throw value;
				}) as never;
				const handler = createOtelClientInterceptor({ serverAddress: "localhost" })(next);

				const { observed, span } = await observedSpan(async () => {
					const outcome = await outcomeOf(() => handler(createMockRequest({ service: "acme.v1.Svc", method: "Run" })));
					assert.deepStrictEqual(outcome, { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
				assert.strictEqual(span.attributes[semconv.ATTR_ERROR_TYPE], "UNKNOWN");
				const points = pointAttributes(observed, semconv.METRIC_RPC_CLIENT_CALL_DURATION);
				assert.strictEqual(points.length, 1);
				assert.strictEqual(points[0]?.[semconv.ATTR_ERROR_TYPE], "UNKNOWN");
			});

			it(`stream: raising ${label} ends the span as failed and reaches the consumer`, async () => {
				async function* failing(): AsyncGenerator<number> {
					yield 1;
					throw value;
				}

				const { span } = await observedSpan(async () => {
					const streamSpan = trace.getTracer("test").startSpan("stream");
					const wrapped = wrapAsyncIterable(failing(), streamSpan, "SENT", false, true);
					const outcome = await outcomeOf(async () => {
						for await (const _message of wrapped) {
							// drain
						}
					});
					assert.deepStrictEqual(outcome, { kind: "threw", value });
				});

				assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
				assert.strictEqual(exceptionEvents(span).length, 1);
			});
		}

		it("keeps the original status message for an Error", async () => {
			const fn = traced(
				() => {
					throw new Error("boom");
				},
				{ name: "fn" },
			);

			const { span } = await observedSpan(async () => {
				syncOutcomeOf(() => fn());
			});

			assert.strictEqual(span.status.message, "boom");
		});

		it("does not let a thrown value whose string conversion throws change the outcome", async () => {
			const hostile = {
				toString() {
					throw new Error("toString bug");
				},
			};
			const fn = traced(
				() => {
					throw hostile;
				},
				{ name: "fn" },
			);

			const { span } = await observedSpan(async () => {
				assert.deepStrictEqual(syncOutcomeOf(() => fn()), { kind: "threw", value: hostile });
			});

			assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
		});
	});
});
