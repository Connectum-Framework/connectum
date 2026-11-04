/**
 * What a real OpenTelemetry Collector receives from a service that sets no `OTEL_*` variable.
 *
 * Without an exporter variable every signal must go over OTLP/HTTP to the default
 * endpoint, `http://localhost:4318`, which is where the OpenTelemetry specification points
 * an unconfigured SDK. The collector is published on that exact port of the loopback
 * interface, so the test needs port 4318 free and is skipped when it is not.
 *
 * It needs Docker and is skipped unless CONNECTUM_REAL_COLLECTOR=1 is set. The container
 * is removed when the file ends, whatever happened.
 */

process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getProvider, shutdownProvider } from "../../src/provider.ts";

const IMAGE = "otel/opentelemetry-collector-contrib:0.154.0";
const CONTAINER = `connectum-otel-default-exporter-${process.pid}`;
const COLLECTOR_CONFIG = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
    logs: { receivers: [otlp], exporters: [debug] }
`;

/** Runs `docker` and returns what it wrote to stdout and stderr (the collector logs to stderr). */
function docker(...args: string[]): string {
    const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout + result.stderr;
}

/** Whether something already listens on loopback port 4318. */
async function port4318IsBusy(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(true));
        probe.listen(4318, "127.0.0.1", () => probe.close(() => resolve(false)));
    });
}

const SAVED_KEYS = [
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_SERVICE_NAME",
] as const;

describe("real collector, no OTEL_* variable", { skip: process.env.CONNECTUM_REAL_COLLECTOR === "1" ? false : "set CONNECTUM_REAL_COLLECTOR=1 (needs Docker)" }, () => {
    const saved = new Map<string, string | undefined>();
    let log = "";
    let skipReason: string | undefined;

    before(async () => {
        if (await port4318IsBusy()) {
            skipReason = "port 4318 on 127.0.0.1 is in use";
            return;
        }
        docker("run", "-d", "--name", CONTAINER, "-p", "127.0.0.1:4318:4318", "-e", `CONFIG_YAML=${COLLECTOR_CONFIG}`, IMAGE, "--config=env:CONFIG_YAML");
        for (let attempt = 0; attempt < 50 && !docker("logs", CONTAINER).includes("Everything is ready"); attempt++) await delay(200);

        for (const key of SAVED_KEYS) {
            saved.set(key, process.env[key]);
            delete process.env[key];
        }
        process.env.OTEL_SERVICE_NAME = "default-exporter-test";
        await shutdownProvider();

        const provider = getProvider();
        provider.tracer.startSpan("default-exporter-span").end();
        provider.meter.createCounter("default_exporter_total").add(1);
        provider.logger.emit({ body: "default-exporter-log" });
        await shutdownProvider();
        await delay(500);
        log = docker("logs", CONTAINER);
    });

    after(async () => {
        try {
            docker("rm", "-f", CONTAINER);
        } catch {
            // The container was never started when the port was busy.
        } finally {
            await shutdownProvider().catch(() => undefined);
            context.disable();
            propagation.disable();
            trace.disable();
            metrics.disable();
            logs.disable();
            for (const [key, value] of saved) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it("delivers a span to the collector on localhost:4318", (t) => {
        if (skipReason !== undefined) return t.skip(skipReason);
        assert.match(log, /default-exporter-span/);
        assert.match(log, /service\.name: Str\(default-exporter-test\)/);
    });

    it("delivers a metric to the collector on localhost:4318", (t) => {
        if (skipReason !== undefined) return t.skip(skipReason);
        assert.match(log, /default_exporter_total/);
    });

    it("delivers a log record to the collector on localhost:4318", (t) => {
        if (skipReason !== undefined) return t.skip(skipReason);
        assert.match(log, /default-exporter-log/);
    });
});
