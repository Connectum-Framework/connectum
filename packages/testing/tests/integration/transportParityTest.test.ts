/**
 * Tests for the cross-transport parity driver itself.
 *
 * Verifies:
 *   - a passing scenario over a trivial echo service runs on both a real HTTP/2
 *     server and the in-process transport, with the response the handler
 *     actually produced;
 *   - an artificially asymmetric scenario fails the driver's test with the
 *     default structural diff;
 *   - the default comparison flags a divergence in each error field on its own.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import type { NormalizedMetric, NormalizedSpan } from "../../src/otel-collectors.ts";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function makeEchoRoutes() {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

describe("transportParityTest driver", () => {
    const runs: { kind: string; baseUrl: string | undefined; listening: boolean; message: string }[] = [];
    const compared: { http: ParityScenarioResult; local: ParityScenarioResult }[] = [];

    // Identical behaviour on both transports → the registered test is green.
    // The scenario asserts the handler's real answer itself, so a driver that
    // handed the scenario a transport pointing nowhere useful would fail here.
    transportParityTest("parity driver: echo behaves identically across transports", {
        services: [makeEchoRoutes()],
        scenario: async ({ transport, transportKind, baseUrl, server }) => {
            const client = createClient(EchoService, transport);
            const res = await client.echo(create(EchoRequestSchema, { message: "hello" }));
            runs.push({ kind: transportKind, baseUrl, listening: server.address !== undefined && server.address !== null, message: res.message });
            return { response: { message: res.message, timestamp: res.timestamp.toString() } };
        },
    });

    // A custom compare receives the HTTP run's result first and the in-process
    // run's result second; the payload names the transport that produced it.
    transportParityTest("parity driver: custom compare receives both results", {
        services: [makeEchoRoutes()],
        scenario: async ({ transportKind }) => ({ response: { via: transportKind } }),
        compare: (http, local) => {
            compared.push({ http, local });
        },
    });

    it("ran the scenario once over HTTP and once in-process, and answered with the handler's response", () => {
        assert.deepStrictEqual(
            runs.map((r) => r.kind),
            ["http", "local"],
        );
        const [http, local] = runs;
        assert.match(http?.baseUrl ?? "", /^http:\/\/localhost:\d+$/, "the HTTP run must get the URL of a bound server");
        assert.strictEqual(http?.listening, true, "the HTTP run must be served by a listening server");
        assert.strictEqual(local?.baseUrl, undefined, "the in-process run has no base URL");
        assert.strictEqual(local?.listening, false, "the in-process run must not bind a port");
        assert.strictEqual(http?.message, "echo:hello");
        assert.strictEqual(local?.message, "echo:hello");
    });

    it("hands the HTTP result first and the in-process result second to compare", () => {
        assert.strictEqual(compared.length, 1);
        assert.deepStrictEqual(compared[0]?.http, { response: { via: "http" } });
        assert.deepStrictEqual(compared[0]?.local, { response: { via: "local" } });
    });
});

describe("transportParityTest with an asymmetric scenario", () => {
    const fixture = fileURLToPath(new URL("../fixtures/parity-asymmetric.fixture.ts", import.meta.url));

    it("fails the registered test with the default structural diff", () => {
        // The runner marks its children with NODE_TEST_CONTEXT; inheriting it would make
        // the child report into this process instead of running as a standalone run.
        const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
        // The fixture is TypeScript; Node 22.13 needs the flag to load it, newer versions accept it.
        const result = spawnSync("node", ["--experimental-strip-types", "--test", fixture], { encoding: "utf8", timeout: 60_000, env });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.notStrictEqual(result.status, 0, `the child test run must fail, output:\n${output}`);
        assert.match(output, /response payload mismatch between HTTP and local transports/);
    });
});

describe("defaultCompare", () => {
    it("passes when responses are deepEqual", () => {
        defaultCompare({ response: { ok: 1 } }, { response: { ok: 1 } });
    });

    it("fails when responses diverge", () => {
        assert.throws(() => defaultCompare({ response: { ok: 1 } }, { response: { ok: 2 } }), /response payload mismatch/);
    });

    describe("error shape: each field alone is enough to fail", () => {
        const base = { code: 5, message: "not_found", details: [{ reason: "x" }], metadata: { "x-tag": "a" } };
        const divergences: { field: string; other: NonNullable<ParityScenarioResult["error"]> }[] = [
            { field: "code", other: { ...base, code: 13 } },
            { field: "message", other: { ...base, message: "internal" } },
            { field: "details", other: { ...base, details: [{ reason: "y" }] } },
            { field: "metadata", other: { ...base, metadata: { "x-tag": "b" } } },
        ];
        for (const { field, other } of divergences) {
            it(`differing ${field} only`, () => {
                assert.throws(() => defaultCompare({ error: base }, { error: other }), /error shape mismatch/);
            });
        }

        it("an error on one transport only", () => {
            assert.throws(() => defaultCompare({ error: base }, { response: { ok: 1 } }), /mismatch/);
            assert.throws(() => defaultCompare({ response: { ok: 1 } }, { error: base }), /mismatch/);
        });
    });

    it("passes when both errors match in every field", () => {
        const error = { code: 5, message: "not_found", details: [{ reason: "x" }], metadata: { "x-tag": "a" } };
        defaultCompare({ error }, { error: { ...error } });
    });

    // The documented invariant covers response headers and trailers, spans (modulo the
    // transport attribute) and metrics (modulo the transport label), not only payloads
    // and errors: a divergence in any of them must fail the comparison on its own.
    describe("headers and trailers", () => {
        for (const field of ["responseHeaders", "trailers"] as const) {
            const failure = field === "responseHeaders" ? /response headers mismatch/ : /trailers mismatch/;

            it(`${field}: equal maps pass`, () => {
                defaultCompare({ [field]: { "x-a": "1" } }, { [field]: { "x-a": "1" } });
            });

            it(`${field}: a differing value fails`, () => {
                assert.throws(() => defaultCompare({ [field]: { "x-a": "1" } }, { [field]: { "x-a": "2" } }), failure);
            });

            it(`${field}: an entry present on one transport only fails`, () => {
                assert.throws(() => defaultCompare({ [field]: { "x-a": "1" } }, { [field]: { "x-a": "1", "x-b": "2" } }), failure);
                assert.throws(() => defaultCompare({ [field]: { "x-a": "1", "x-b": "2" } }, { [field]: { "x-a": "1" } }), failure);
            });

            it(`${field}: a non-empty map against none at all fails`, () => {
                assert.throws(() => defaultCompare({ [field]: { "x-a": "1" } }, {}), failure);
                assert.throws(() => defaultCompare({}, { [field]: { "x-a": "1" } }), failure);
            });

            it(`${field}: protocol headers that differ between the transports are ignored`, () => {
                const http = { "x-a": "1", "content-type": "application/grpc+proto", date: "Thu, 29 Oct 2026 08:09:43 GMT", "grpc-encoding": "gzip", "grpc-status": "0", "grpc-message": "ok" };
                const local = { "x-a": "1", "content-type": "application/proto", "content-length": "4", "connect-content-encoding": "identity", "Content-Encoding": "identity" };
                defaultCompare({ [field]: http }, { [field]: local });
                // A leg that reports nothing but protocol headers equals one that reports nothing.
                const { "x-a": _application, ...protocolOnly } = http;
                defaultCompare({ [field]: protocolOnly }, { [field]: {} });
                defaultCompare({ [field]: protocolOnly }, {});
            });

            it(`${field}: a differing application entry still fails next to differing protocol headers`, () => {
                assert.throws(() => defaultCompare({ [field]: { "x-a": "1", "content-type": "a" } }, { [field]: { "x-a": "2", "content-type": "b" } }), failure);
            });

            it(`${field}: only the grpc- and connect- name families are protocol headers, not any name containing them`, () => {
                assert.throws(() => defaultCompare({ [field]: { "x-grpc-tag": "1" } }, { [field]: { "x-grpc-tag": "2" } }), failure);
                assert.throws(() => defaultCompare({ [field]: { "x-connect-tag": "1" } }, { [field]: {} }), failure);
            });
        }

        it("error metadata: protocol headers are ignored, application entries still fail", () => {
            const base = { code: 5, message: "nope" };
            defaultCompare(
                { error: { ...base, metadata: { "x-tag": "a", "content-type": "application/grpc+proto", "grpc-status": "5", "grpc-message": "nope", date: "x" } } },
                { error: { ...base, metadata: { "x-tag": "a", "content-type": "application/json", "content-length": "37" } } },
            );
            assert.throws(
                () => defaultCompare({ error: { ...base, metadata: { "x-tag": "a", "grpc-status": "5" } } }, { error: { ...base, metadata: { "x-tag": "b", "content-length": "37" } } }),
                /error shape mismatch/,
            );
            assert.throws(
                () => defaultCompare({ error: { ...base, metadata: { "grpc-status": "5" } } }, { error: { ...base, metadata: { "x-tag": "a" } } }),
                /error shape mismatch/,
            );
        });

        it("error metadata: reported on one side only still differs from an error that reports none", () => {
            const base = { code: 5, message: "nope" };
            assert.throws(() => defaultCompare({ error: { ...base, metadata: { "x-tag": "a" } } }, { error: base }), /error shape mismatch/);
            defaultCompare({ error: base }, { error: base });
        });
    });

    describe("spans", () => {
        const span = (overrides: Partial<NormalizedSpan> = {}): NormalizedSpan => ({
            name: "echo.v1.EchoService/Echo",
            kind: 1,
            attributes: { "rpc.method": "Echo" },
            events: [{ name: "message", attributes: { "message.type": "RECEIVED" } }],
            status: { code: 0, message: undefined },
            traceId: "trace-http",
            spanId: "span-http",
            parentSpanId: "parent-http",
            ...overrides,
        });

        it("ignores the identifiers that legitimately differ between independent runs", () => {
            defaultCompare({ spans: [span()] }, { spans: [span({ traceId: "trace-local", spanId: "span-local", parentSpanId: "parent-local" })] });
        });

        const divergences: { field: string; other: NormalizedSpan }[] = [
            { field: "name", other: span({ name: "echo.v1.EchoService/SecureEcho" }) },
            { field: "kind", other: span({ kind: 2 }) },
            { field: "attributes", other: span({ attributes: { "rpc.method": "SecureEcho" } }) },
            { field: "events", other: span({ events: [] }) },
            { field: "status code", other: span({ status: { code: 2, message: undefined } }) },
            { field: "status message", other: span({ status: { code: 0, message: "boom" } }) },
            { field: "parent presence", other: span({ parentSpanId: undefined }) },
        ];
        for (const { field, other } of divergences) {
            it(`a differing ${field} alone fails`, () => {
                assert.throws(() => defaultCompare({ spans: [span()] }, { spans: [other] }), /OTEL spans mismatch/);
            });
        }

        it("a different number of spans fails", () => {
            assert.throws(() => defaultCompare({ spans: [span()] }, { spans: [span(), span({ name: "second" })] }), /OTEL spans mismatch/);
        });

        it("spans reported by one transport only fail", () => {
            assert.throws(() => defaultCompare({ spans: [span()] }, {}), /OTEL spans mismatch/);
            assert.throws(() => defaultCompare({}, { spans: [span()] }), /OTEL spans mismatch/);
        });
    });

    describe("metrics", () => {
        const metric = (overrides: Partial<NormalizedMetric> = {}): NormalizedMetric => ({
            name: "rpc.server.duration",
            description: "call duration",
            unit: "ms",
            type: "1",
            points: [{ attributes: { "rpc.method": "Echo" }, value: 1 }],
            ...overrides,
        });

        it("equal metrics pass", () => {
            defaultCompare({ metrics: [metric()] }, { metrics: [metric()] });
        });

        const divergences: { field: string; other: NormalizedMetric }[] = [
            { field: "name", other: metric({ name: "rpc.client.duration" }) },
            { field: "unit", other: metric({ unit: "s" }) },
            { field: "type", other: metric({ type: "2" }) },
            { field: "label set", other: metric({ points: [{ attributes: { "rpc.method": "SecureEcho" }, value: 1 }] }) },
            { field: "recorded value", other: metric({ points: [{ attributes: { "rpc.method": "Echo" }, value: 2 }] }) },
        ];
        for (const { field, other } of divergences) {
            it(`a differing ${field} alone fails`, () => {
                assert.throws(() => defaultCompare({ metrics: [metric()] }, { metrics: [other] }), /OTEL metrics mismatch/);
            });
        }

        it("metrics reported by one transport only fail", () => {
            assert.throws(() => defaultCompare({ metrics: [metric()] }, {}), /OTEL metrics mismatch/);
            assert.throws(() => defaultCompare({}, { metrics: [metric()] }), /OTEL metrics mismatch/);
        });
    });

    describe("readMaxBytes diagnostic text is the single documented exemption", () => {
        const exhausted = (message: string) => ({ error: { code: 8, message } });

        it("treats a message with the observed size and one without as equal for the same limit", () => {
            defaultCompare(exhausted("message size 70 is larger than configured readMaxBytes 64"), exhausted("message size is larger than configured readMaxBytes 64"));
        });

        it("still fails when the configured limits differ", () => {
            assert.throws(
                () => defaultCompare(exhausted("message size 70 is larger than configured readMaxBytes 64"), exhausted("message size is larger than configured readMaxBytes 128")),
                /error shape mismatch/,
            );
        });

        it("still fails for any other ResourceExhausted text", () => {
            assert.throws(() => defaultCompare(exhausted("quota exhausted"), exhausted("rate exceeded")), /error shape mismatch/);
        });

        it("does not extend the exemption to other codes", () => {
            assert.throws(
                () => defaultCompare({ error: { code: 3, message: "message size 70 is larger than configured readMaxBytes 64" } }, { error: { code: 3, message: "message size is larger than configured readMaxBytes 64" } }),
                /error shape mismatch/,
            );
        });
    });
});
