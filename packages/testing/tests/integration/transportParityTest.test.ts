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
        const result = spawnSync("node", ["--test", fixture], { encoding: "utf8", timeout: 60_000, env });
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
