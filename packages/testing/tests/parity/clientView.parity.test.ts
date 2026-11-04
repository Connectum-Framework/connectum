/**
 * Group 10 — Headers, trailers and error metadata exactly as the client sees them.
 *
 * A scenario that reports what the client library hands it, without filtering,
 * must pass when the service behaves the same on both transports. The two
 * client legs carry different protocol headers (`content-type`,
 * `content-length`, `date`, `grpc-*`); the default comparison ignores those and
 * still compares every application header, trailer and metadata entry.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { defaultCompare, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function clientViewRoutes() {
    return defineService(EchoService, {
        echo: (req, ctx) => {
            if (req.message === "missing") {
                throw new ConnectError("nope", Code.NotFound, { "x-error-tag": "user-42" });
            }
            ctx.responseHeader.set("x-app-header", "h1");
            ctx.responseTrailer.set("x-app-trailer", "t1");
            return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
        },
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

transportParityTest("parity 10.1: response headers reported as the client sees them", {
    services: [clientViewRoutes()],
    scenario: async ({ transport }) => {
        let responseHeaders: Record<string, string> = {};
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" }), {
            onHeader: (h) => {
                responseHeaders = Object.fromEntries(h);
            },
        });
        return { response: { message: res.message }, responseHeaders };
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.responseHeaders?.["x-app-header"], "h1", `${name} transport must deliver the handler's response header`);
        }
        // The raw maps differ in protocol headers; the scenario does not filter them.
        assert.notDeepStrictEqual(http.responseHeaders, local.responseHeaders, "the two legs are expected to carry different protocol headers");
        defaultCompare(http, local);
    },
});

transportParityTest("parity 10.2: trailers reported as the client sees them", {
    services: [clientViewRoutes()],
    scenario: async ({ transport }) => {
        let trailers: Record<string, string> = {};
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" }), {
            onTrailer: (t) => {
                trailers = Object.fromEntries(t);
            },
        });
        return { response: { message: res.message }, trailers };
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.trailers?.["x-app-trailer"], "t1", `${name} transport must deliver the handler's trailer`);
        }
        assert.notDeepStrictEqual(http.trailers, local.trailers, "the two legs are expected to carry different protocol trailers");
        defaultCompare(http, local);
    },
});

transportParityTest("parity 10.3: ConnectError metadata reported as the client sees it", {
    services: [clientViewRoutes()],
    scenario: async ({ transport }) => {
        try {
            await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "missing" }));
            return { response: { unreachable: true } };
        } catch (err) {
            const error = ConnectError.from(err);
            return { error: { code: error.code, message: error.rawMessage, metadata: Object.fromEntries(error.metadata) } };
        }
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.error?.code, Code.NotFound, `${name} transport must deliver the code`);
            assert.strictEqual(result.error?.metadata?.["x-error-tag"], "user-42", `${name} transport must deliver the handler's metadata entry`);
        }
        assert.notDeepStrictEqual(http.error?.metadata, local.error?.metadata, "the two legs are expected to carry different protocol metadata");
        defaultCompare(http, local);
    },
});
