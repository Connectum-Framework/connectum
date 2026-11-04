/**
 * What a real OpenTelemetry Collector receives from the RPC interceptors.
 *
 * The other tests read telemetry from in-memory exporters. This one sends it over OTLP to
 * the official collector image and reads what the collector decoded, so the values a
 * dashboard or an alert would see are checked after serialization too: message sizes,
 * the duration of a streaming call, the attributes of a failed stream, the span status
 * of a server error and of a caller error, and `exception.type`.
 *
 * It needs Docker and is skipped unless CONNECTUM_REAL_COLLECTOR=1 is set. One container
 * runs for the whole file and is removed when the file ends, whatever happened. The
 * collector is configured through an environment variable, so no file is written.
 */

process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_METRICS_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, defineService } from "@connectum/core";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createOtelClientInterceptor } from "../../src/client-interceptor.ts";
import { createOtelInterceptor } from "../../src/interceptor.ts";
import { shutdownProvider } from "../../src/provider.ts";

const IMAGE = "otel/opentelemetry-collector-contrib:0.154.0";
const CONTAINER = `connectum-otel-real-collector-${process.pid}`;
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
`;

/** Runs `docker` and returns what it wrote to stdout and stderr (the collector logs to stderr). */
function docker(...args: string[]): string {
    const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout + result.stderr;
}

/** The blocks of the collector's debug output that start with `marker`, as text. */
function blocksOf(log: string, marker: RegExp): string[] {
    return log.split(marker).slice(1);
}

describe("real collector", { skip: process.env.CONNECTUM_REAL_COLLECTOR === "1" ? false : "set CONNECTUM_REAL_COLLECTOR=1 (needs Docker)" }, () => {
    let log = "";
    let sizes: { request: number; response: number } = { request: 0, response: 0 };

    before(async () => {
        docker("run", "-d", "--name", CONTAINER, "-p", "127.0.0.1::4318", "-e", `CONFIG_YAML=${COLLECTOR_CONFIG}`, IMAGE, "--config=env:CONFIG_YAML");
        const endpoint = `http://127.0.0.1:${docker("port", CONTAINER, "4318/tcp").trim().split(":").pop()}`;
        for (let attempt = 0; attempt < 50 && !docker("logs", CONTAINER).includes("Everything is ready"); attempt++) await delay(200);

        // Upper case: the value is matched case-insensitively. The percent-encoded comma in the
        // resource attribute must reach the collector decoded.
        process.env.OTEL_TRACES_EXPORTER = "OTLP/HTTP";
        process.env.OTEL_METRICS_EXPORTER = "otlp/http";
        process.env.OTEL_LOGS_EXPORTER = "none";
        process.env.OTEL_RESOURCE_ATTRIBUTES = "team=a%2Cb";
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
        process.env.OTEL_SERVICE_NAME = "real-collector-test";
        await shutdownProvider();

        const routes = defineService(StreamingService, {
            echo: (req) => {
                if (req.value === "missing") throw new ConnectError("no such item", Code.NotFound);
                if (req.value === "broken") throw new ConnectError("backend gone", Code.Unavailable);
                return create(ItemSchema, { value: req.value, sequence: req.sequence });
            },
            async *server(req) {
                for (let i = 0; i < 3; i++) {
                    await delay(100);
                    if (req.value === "fail" && i === 2) throw new ConnectError("stream broke", Code.Unavailable);
                    yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
                }
            },
            async client(requests) {
                let total = 0;
                for await (const _ of requests) total++;
                return { total };
            },
            async *bidi(requests) {
                for await (const item of requests) yield create(ItemSchema, { value: item.value, sequence: item.sequence });
            },
        });
        const server = createServer({ services: [routes], port: 0, allowHTTP1: false, interceptors: [createOtelInterceptor({ recordMessages: true })] });
        await server.start();
        try {
            const port = server.address?.port;
            const client = createClient(
                StreamingService,
                createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}`, interceptors: [createOtelClientInterceptor({ serverAddress: "127.0.0.1", recordMessages: true })] }),
            );
            const request = create(ItemSchema, { value: "x".repeat(2000), sequence: 7 });
            const response = await client.echo(request);
            sizes = { request: JSON.stringify(request.value).length, response: response.value.length };
            await assert.rejects(() => client.echo(create(ItemSchema, { value: "missing" })));
            await assert.rejects(() => client.echo(create(ItemSchema, { value: "broken" })));
            for await (const _ of client.server(create(ItemSchema, { value: "ok" }))) {
                // Drain: the calls end with the stream.
            }
            await assert.rejects(async () => {
                for await (const _ of client.server(create(ItemSchema, { value: "fail" }))) {
                    // Drain until the stream fails.
                }
            });
        } finally {
            await server.stop();
        }
        await shutdownProvider();
        await delay(500);
        log = docker("logs", CONTAINER);
    });

    after(async () => {
        try {
            docker("rm", "-f", CONTAINER);
        } finally {
            await shutdownProvider();
            context.disable();
            propagation.disable();
            trace.disable();
            metrics.disable();
            logs.disable();
        }
    });

    /** The data points of one metric as text blocks. */
    const pointsOf = (name: string) =>
        blocksOf(log, /Metric #\d+\n/)
            .filter((block) => block.includes(`-> Name: ${name}\n`))
            .flatMap((block) => blocksOf(block, /HistogramDataPoints #\d+\n/));
    const sumOf = (block: string) => Number(/Sum: ([0-9.e+-]+)/.exec(block)?.[1]);

    it("receives the percent-decoded resource attribute on spans and metrics", () => {
        assert.match(log, /-> team: Str\(a,b\)/);
        assert.ok(!log.includes("a%2Cb"), "the encoded form must not reach the collector");
        assert.ok(blocksOf(log, /Span #\d+\n/).length > 0, "spans arrived through the upper-case exporter name");
    });

    it("receives the serialized sizes of a unary call", () => {
        const request = pointsOf("rpc.server.request.size").find((block) => block.includes("Str(streaming.v1.StreamingService/Echo)") && !block.includes("error.type"));
        assert.ok(request, `no rpc.server.request.size point for Echo in:\n${log}`);
        // The message is a 2000-character string and an int32: tag + varint length + bytes + tag + varint.
        assert.ok(sumOf(request) >= 2000 && sumOf(request) < 2100, `request size ${sumOf(request)} (value ${sizes.request})`);
    });

    it("receives the duration of a streaming call covering the whole stream", () => {
        const stream = pointsOf("rpc.server.call.duration").find((block) => block.includes("StreamingService/Server") && !block.includes("error.type"));
        assert.ok(stream, `no rpc.server.call.duration point for a finished stream in:\n${log}`);
        assert.ok(sumOf(stream) >= 0.3, `duration ${sumOf(stream)} s`);
    });

    it("receives error.type and rpc.response.status_code on the failed stream, on the metric and the span", () => {
        const stream = pointsOf("rpc.server.call.duration").find((block) => block.includes("StreamingService/Server") && block.includes("Str(UNAVAILABLE)"));
        assert.ok(stream, `no failed-stream duration point in:\n${log}`);
        assert.match(stream, /-> error\.type: Str\(UNAVAILABLE\)/);
        assert.match(stream, /-> rpc\.response\.status_code: Str\(UNAVAILABLE\)/);
        assert.ok(sumOf(stream) >= 0.2, `duration ${sumOf(stream)} s`);
    });

    /** Server and client spans of one method with the given status code as text blocks. */
    const spansOf = (kind: "Server" | "Client", method: string, errorType?: string) =>
        blocksOf(log, /Span #\d+\n/).filter((block) => block.includes(`Kind           : ${kind}`) && block.includes(`Str(${method})`) && (errorType === undefined || block.includes(`Str(${errorType})`)));

    it("leaves the server span status unset for NOT_FOUND and marks the client span, and marks both for UNAVAILABLE", () => {
        const [serverNotFound] = spansOf("Server", "streaming.v1.StreamingService/Echo", "NOT_FOUND");
        const [clientNotFound] = spansOf("Client", "streaming.v1.StreamingService/Echo", "NOT_FOUND");
        const [serverUnavailable] = spansOf("Server", "streaming.v1.StreamingService/Echo", "UNAVAILABLE");
        assert.ok(serverNotFound && clientNotFound && serverUnavailable, `spans missing in:\n${log}`);
        assert.match(serverNotFound, /Status code\s*: Unset/);
        assert.match(clientNotFound, /Status code\s*: Error/);
        assert.match(serverUnavailable, /Status code\s*: Error/);
    });

    it("receives the class name as exception.type of a ConnectError", () => {
        const [span] = spansOf("Server", "streaming.v1.StreamingService/Echo", "UNAVAILABLE");
        assert.ok(span);
        assert.match(span, /-> exception\.type: Str\(ConnectError\)/);
        assert.ok(!/-> exception\.type: Str\(\d+\)/.test(span), "no numeric exception.type");
    });
});
