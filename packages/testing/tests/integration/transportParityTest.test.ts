/**
 * Smoke tests for the cross-transport parity driver itself.
 *
 * Verifies:
 *   - a passing scenario over a trivial echo service exits cleanly (both
 *     HTTP and local runs produce identical results);
 *   - an artificially asymmetric scenario fails with a parity-related
 *     assertion error.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { type ConnectRouter, createClient } from "@connectrpc/connect";
import { defaultCompare, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function makeEchoRoutes() {
    return (router: ConnectRouter) => {
        router.service(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    };
}

// Top-level driver registration: identical behaviour → green test.
transportParityTest("parity driver: echo behaves identically across transports", {
    services: [makeEchoRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "hello" }));
        return { response: { message: res.message, timestamp: res.timestamp.toString() } };
    },
});

describe("defaultCompare", () => {
    it("passes when responses are deepEqual", () => {
        defaultCompare({ response: { ok: 1 } }, { response: { ok: 1 } });
    });

    it("fails when responses diverge", () => {
        assert.throws(
            () => defaultCompare({ response: { ok: 1 } }, { response: { ok: 2 } }),
            /response payload mismatch/,
        );
    });

    it("fails when errors diverge", () => {
        assert.throws(
            () => defaultCompare({ error: { code: 5, message: "not_found" } }, { error: { code: 13, message: "internal" } }),
            /error shape mismatch/,
        );
    });

    it("passes when both errors match", () => {
        defaultCompare(
            { error: { code: 5, message: "not_found" } },
            { error: { code: 5, message: "not_found" } },
        );
    });
});
