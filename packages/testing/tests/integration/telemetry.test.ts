/**
 * `withTelemetry` and the `telemetry` option of `transportParityTest` give each
 * scenario telemetry of its own. These tests drive them with a stand-in for
 * `shutdownProvider` that records when it is called, and with spans recorded
 * through the OpenTelemetry API, so they check what a scenario observes: which
 * collector receives a span, in which order the reset and the registration
 * happen, and what is left registered afterwards. The end-to-end proof with the
 * real `@connectum/otel` lives in that package's parity tests.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { metrics as metricsApi, trace } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { withTelemetry } from "../../src/telemetry.ts";
import { transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/** A `shutdownProvider` stand-in that logs the span provider registered at each call. */
function recordingShutdown(log: string[]): () => Promise<void> {
    return async () => {
        // `trace.getTracerProvider()` is the API's delegating proxy; a span
        // started through it reaches whichever collector is registered right now.
        const span = trace.getTracer("probe").startSpan("probe");
        log.push(`shutdown (recording=${span.isRecording()})`);
        span.end();
    };
}

/**
 * The API accepts a provider only when none is registered, so a successful
 * registration of a fresh one proves that nothing was left behind.
 */
function assertNothingRegistered(): void {
    const tracerFree = trace.setGlobalTracerProvider(new BasicTracerProvider());
    const meterFree = metricsApi.setGlobalMeterProvider(new MeterProvider());
    trace.disable();
    metricsApi.disable();
    assert.strictEqual(tracerFree, true, "a tracer provider is still registered");
    assert.strictEqual(meterFree, true, "a meter provider is still registered");
}

describe("withTelemetry", () => {
    it("resets the provider before it registers the collectors, and again after the body", async () => {
        const log: string[] = [];
        await withTelemetry({ shutdownProvider: recordingShutdown(log) }, async ({ spans }) => {
            log.push("body");
            trace.getTracer("t").startSpan("inside").end();
            assert.deepStrictEqual(
                spans.flush().map((s) => s.name),
                ["inside"],
            );
        });
        // Before registration nothing is recording; after the body the
        // registration has been removed, so nothing is recording either.
        assert.deepStrictEqual(log, ["shutdown (recording=false)", "body", "shutdown (recording=false)"]);
    });

    it("gives three scenarios in a row one span each, none of another scenario's", async () => {
        const seen: string[][] = [];
        for (const name of ["first", "second", "third"]) {
            await withTelemetry({ shutdownProvider: async () => {} }, async ({ spans }) => {
                trace.getTracer("t").startSpan(name).end();
                seen.push(spans.flush().map((s) => s.name));
            });
        }
        assert.deepStrictEqual(seen, [["first"], ["second"], ["third"]]);
    });

    it("returns what the body returned", async () => {
        const result = await withTelemetry({ shutdownProvider: async () => {} }, async () => 42);
        assert.strictEqual(result, 42);
    });

    it("unregisters the collectors and resets the provider when the body throws, and rethrows the body's error", async () => {
        const log: string[] = [];
        await assert.rejects(
            withTelemetry({ shutdownProvider: recordingShutdown(log) }, async () => {
                throw new Error("scenario failed");
            }),
            /scenario failed/,
        );
        assert.deepStrictEqual(log, ["shutdown (recording=false)", "shutdown (recording=false)"], "shutdownProvider runs before the body and once more after it, with the collectors already unregistered");
        assertNothingRegistered();
    });

    it("leaves neither a tracer nor a meter provider registered after the body", async () => {
        await withTelemetry({ shutdownProvider: async () => {} }, async ({ metrics }) => {
            metricsApi.getMeter("m").createCounter("inside").add(1);
            assert.deepStrictEqual(
                (await metrics.flush()).map((m) => m.name),
                ["inside"],
            );
        });
        assertNothingRegistered();
    });

    it("disposes the collectors once the body ends", async () => {
        let metricsCollector: Parameters<Parameters<typeof withTelemetry>[1]>[0]["metrics"] | undefined;
        await withTelemetry({ shutdownProvider: async () => {} }, async ({ metrics }) => {
            metricsCollector = metrics;
        });
        await assert.rejects(metricsCollector?.flush() ?? Promise.resolve(), /after dispose/);
    });

    it("refuses a second scenario while one holds the providers, and lets the first finish with its own span", async () => {
        const noop = { shutdownProvider: async () => {} };
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = withTelemetry(noop, async ({ spans }) => {
            await gate;
            trace.getTracer("t").startSpan("first").end();
            return spans.flush().map((s) => s.name);
        });
        await assert.rejects(
            withTelemetry(noop, async () => {}),
            /already holds the OpenTelemetry providers/,
        );
        release();
        assert.deepStrictEqual(await first, ["first"]);
        // The refusal must not have released the first scenario's hold early
        // or kept it afterwards: a following scenario starts normally.
        assert.strictEqual(await withTelemetry(noop, async () => "next"), "next");
        assertNothingRegistered();
    });

    it("rejects a missing or non-function shutdownProvider with a TypeError that names it", async () => {
        for (const bad of [undefined, null, {}, { shutdownProvider: "nope" }]) {
            await assert.rejects(
                withTelemetry(bad as never, async () => {}),
                (error: unknown) => error instanceof TypeError && /telemetry\.shutdownProvider must be a function/.test(error.message),
            );
        }
    });
});

describe("transportParityTest telemetry option", () => {
    const echo = defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
    const calls: string[] = [];

    // The scenario records one span through the OpenTelemetry API and reads it
    // back from `ctx.spans` without registering anything itself: that only
    // works if the driver registered this run's collector.
    for (const name of ["first", "second", "third"]) {
        transportParityTest(`telemetry: ${name} scenario sees its own span on both transports`, {
            services: [echo],
            telemetry: {
                shutdownProvider: async () => {
                    calls.push("shutdown");
                },
            },
            scenario: async ({ transport, spans, transportKind }) => {
                await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: name }));
                trace.getTracer("scenario").startSpan(`${name}:${transportKind}`).end();
                const names = spans.flush().map((s) => s.name);
                assert.deepStrictEqual(names, [`${name}:${transportKind}`], "each run's collector holds only that run's span");
                return { response: names.length };
            },
        });
    }

    it("reset the provider before and after each of the six runs", () => {
        // 3 tests x 2 transports x (before + after)
        assert.strictEqual(calls.length, 12);
    });

    it("rejects a telemetry option without shutdownProvider when the test is declared", () => {
        assert.throws(
            () => transportParityTest("bad telemetry", { services: [echo], telemetry: {} as never, scenario: async () => ({}) }),
            (error: unknown) => error instanceof TypeError && /telemetry\.shutdownProvider must be a function/.test(error.message),
        );
    });
});
