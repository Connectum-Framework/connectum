/**
 * A user callback that throws must not fail the observed call.
 *
 * `filter` and `attributeFilter` are the application's code running on the path of
 * every RPC. The telemetry layer must never turn a bug in them into a failed request
 * (code `internal` on the server, `unknown` on the client). The error is reported once
 * per interceptor through the OpenTelemetry diagnostics channel, not once per call.
 * A throwing `filter` instruments the call (losing telemetry silently is worse than an
 * extra span); a throwing `attributeFilter` drops the attribute it was asked about
 * (an attribute is exported only if the filter approved it).
 */

process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { getProvider, shutdownProvider } from "../../src/provider.ts";
import type { OtelAttributeFilter, OtelFilter } from "../../src/types.ts";
import { observe, onlySpan, pointAttributes } from "./observe.ts";

const FULL_METHOD = "acme.greeter.v1.GreeterService/SayHello";

interface Side {
    label: "server" | "client";
    create(options: { filter?: OtelFilter; attributeFilter?: OtelAttributeFilter; withoutTracing?: boolean }): Interceptor;
    durationMetric: string;
}

const SIDES: Side[] = [
    { label: "server", create: (options) => createOtelInterceptor(options), durationMetric: "rpc.server.call.duration" },
    { label: "client", create: (options) => createOtelClientInterceptor({ serverAddress: "api.example.com", ...options }), durationMetric: "rpc.client.call.duration" },
];

const request = () => createMockRequest({ service: "acme.greeter.v1.GreeterService", method: "SayHello" });

/** Runs `body` with a diagnostics logger that collects the error-level reports. */
async function collectingDiagnostics(body: (reports: string[]) => Promise<void>): Promise<string[]> {
    const reports: string[] = [];
    await observe(async () => {
        // The telemetry provider installs its own diagnostics logger when it is created;
        // create it first so that the collecting logger is the last one registered.
        getProvider();
        diag.setLogger(
            {
                error: (message) => void reports.push(message),
                warn: () => {},
                info: () => {},
                debug: () => {},
                verbose: () => {},
            },
            { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true },
        );
        try {
            await body(reports);
        } finally {
            diag.disable();
        }
    });
    return reports;
}

describe("a throwing user callback", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    for (const side of SIDES) {
        describe(`${side.label} interceptor`, () => {
            it("lets the call succeed and instruments it when filter throws", async () => {
                const next = createMockNext({ message: { ok: true } });
                const handler = side.create({
                    filter: () => {
                        throw new Error("filterbug");
                    },
                })(next);
                let response: unknown;

                const observed = await observe(async () => {
                    response = await handler(request());
                });

                assert.ok(response, "the call returns its response");
                assert.strictEqual(next.mock.calls.length, 1);
                assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
                assert.strictEqual(pointAttributes(observed, side.durationMetric).length, 1, "the call is measured");
            });

            it("instruments the call in metrics-only mode when filter throws", async () => {
                const handler = side.create({
                    withoutTracing: true,
                    filter: () => {
                        throw new Error("filterbug");
                    },
                })(createMockNext({ message: { ok: true } }));

                const observed = await observe(async () => {
                    await handler(request());
                });

                assert.deepStrictEqual(observed.spans, []);
                assert.strictEqual(pointAttributes(observed, side.durationMetric).length, 1);
            });

            it("lets the call succeed and drops the attributes when attributeFilter throws", async () => {
                const handler = side.create({
                    attributeFilter: () => {
                        throw new Error("afbug");
                    },
                })(createMockNext({ message: { ok: true } }));
                let response: unknown;

                const observed = await observe(async () => {
                    response = await handler(request());
                });

                assert.ok(response, "the call returns its response");
                const span = onlySpan(observed);
                assert.ok(!("rpc.method" in span.attributes), "an attribute the filter could not approve is not exported");
                assert.ok(!("server.address" in span.attributes));
                assert.strictEqual(span.attributes["rpc.response.status_code"], "OK", "attributes added after filtering are unaffected");
                const [point] = pointAttributes(observed, side.durationMetric);
                assert.ok(point, "the call is measured");
                assert.ok(!("rpc.method" in point));
            });

            it("keeps the attributes the throwing attributeFilter was not asked to reject", async () => {
                const handler = side.create({
                    attributeFilter: (key) => {
                        if (key === "network.transport") throw new Error("afbug");
                        return true;
                    },
                })(createMockNext({ message: { ok: true } }));

                const observed = await observe(async () => {
                    await handler(request());
                });

                const span = onlySpan(observed);
                assert.strictEqual(span.attributes["rpc.method"], FULL_METHOD);
                assert.ok(!("network.transport" in span.attributes));
            });

            it("reports a throwing filter once per interceptor, not once per call", async () => {
                const handler = side.create({
                    filter: () => {
                        throw new Error("filterbug");
                    },
                })(createMockNext({ message: { ok: true } }));

                const reports = await collectingDiagnostics(async () => {
                    await handler(request());
                    await handler(request());
                    await handler(request());
                });

                assert.strictEqual(reports.length, 1, `reports: ${JSON.stringify(reports)}`);
                assert.match(reports[0] ?? "", /filter/);
                assert.match(reports[0] ?? "", /filterbug/);
            });

            it("reports a throwing attributeFilter once per interceptor, not once per attribute or call", async () => {
                const handler = side.create({
                    attributeFilter: () => {
                        throw new Error("afbug");
                    },
                })(createMockNext({ message: { ok: true } }));

                const reports = await collectingDiagnostics(async () => {
                    await handler(request());
                    await handler(request());
                });

                assert.strictEqual(reports.length, 1, `reports: ${JSON.stringify(reports)}`);
                assert.match(reports[0] ?? "", /attributeFilter/);
                assert.match(reports[0] ?? "", /afbug/);
            });

            // The provider installs the diagnostics logger when it is created, and a callback
            // runs before the first use of the tracer: a report made before the provider
            // exists would go nowhere, and it is made only once.
            it("reports a throwing filter even when the provider does not exist yet", async () => {
                const handler = side.create({
                    filter: () => {
                        throw new Error("filterbug");
                    },
                })(createMockNext({ message: { ok: true } }));
                // The default diagnostics logger prints with the console methods saved when
                // the OpenTelemetry API was loaded, so the output is read at the stream.
                const printed: string[] = [];
                const originalWrite = process.stderr.write;
                process.stderr.write = ((chunk: string | Uint8Array) => {
                    printed.push(String(chunk));
                    return true;
                }) as typeof process.stderr.write;
                try {
                    await observe(async () => {
                        await handler(request());
                    });
                } finally {
                    process.stderr.write = originalWrite;
                    diag.disable();
                }

                assert.ok(
                    printed.some((line) => line.includes("filterbug")),
                    `printed: ${JSON.stringify(printed)}`,
                );
            });

            it("does not let a throw of a non-error value fail the call", async () => {
                const handler = side.create({
                    filter: () => {
                        throw null;
                    },
                })(createMockNext({ message: { ok: true } }));

                const observed = await observe(async () => {
                    await handler(request());
                });

                assert.strictEqual(onlySpan(observed).name, FULL_METHOD);
            });
        });
    }
});
