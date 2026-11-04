/**
 * Parity scenarios that follow one another in one process must each record
 * their own spans.
 *
 * `@connectum/otel` keeps the tracer it created for the provider registered
 * when it first recorded something. A scenario that registers its collector
 * without resetting the provider therefore records nothing from the second one
 * on, and a parity comparison of two empty results passes. The `telemetry`
 * option of `transportParityTest` and `withTelemetry` reset the provider for
 * the scenario; these tests run three scenarios of each kind in a row against
 * the real interceptor and require one server span per run.
 */

// MUST run before any @connectum/otel import resolves transitively.
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { withTelemetry } from "@connectum/testing";
import { transportParityTest } from "@connectum/testing/parity";
import { SpanKind } from "@opentelemetry/api";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const services = [
    defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    }),
];

// One interceptor instance for every scenario and both transports, as a suite
// that builds it once at module level has it.
const interceptor = createOtelInterceptor();

describe("telemetry isolation across parity scenarios", () => {
    for (const name of ["first", "second", "third"]) {
        transportParityTest(`${name} scenario records its own server span on both transports`, {
            services,
            interceptors: [interceptor],
            telemetry: { shutdownProvider },
            scenario: async ({ transport, spans, metrics, transportKind }) => {
                const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: name }));
                const recorded = spans.flush();
                // Two empty lists compare as equal, so the scenario asserts the
                // telemetry is there before it returns it.
                assert.strictEqual(recorded.length, 1, `${transportKind}: exactly one span expected, got ${recorded.length}`);
                assert.strictEqual(recorded[0]?.kind, SpanKind.SERVER);
                assert.strictEqual(recorded[0]?.name, "echo.v1.EchoService/Echo");
                const recordedMetrics = await metrics.flush();
                assert.ok(recordedMetrics.length > 0, `${transportKind}: no metric recorded`);
                return { response: res.message, spans: recorded, metrics: recordedMetrics };
            },
        });
    }

    it("withTelemetry gives three direct calls in a row one span each", async () => {
        const server = createServer({ services, interceptors: [interceptor], port: 0 });
        const client = createClient(EchoService, createLocalTransport(server));
        const counts: number[] = [];
        for (const name of ["first", "second", "third"]) {
            await withTelemetry({ shutdownProvider }, async ({ spans }) => {
                await client.echo(create(EchoRequestSchema, { message: name }));
                counts.push(spans.flush().length);
            });
        }
        assert.deepStrictEqual(counts, [1, 1, 1]);
    });
});
