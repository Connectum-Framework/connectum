/**
 * Request admission parity: `createServer({ requestGate, readMaxBytes })`.
 *
 * A request is admitted or rejected identically whichever transport carries
 * it — there is no in-process exemption. These scenarios pin that for a
 * rejecting gate (code, message, error metadata, handler never invoked), an
 * admitting gate, and the per-message read limit.
 *
 * Documented carve-out: the diagnostic TEXT of a read-limit rejection may
 * differ. Connect includes the observed size only when it knows the total
 * message length up front (the gRPC envelope over HTTP does; the in-process
 * unary body does not). `defaultCompare` treats exactly that difference as
 * equal; the code, the configured limit, metadata and handler invocation are
 * still compared as-is. The self-tests at the bottom prove the carve-out
 * cannot hide any other message difference.
 */

import assert from "node:assert";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type HandlerContext } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

type ReportedError = NonNullable<ParityScenarioResult["error"]>;

/** Echo routes whose handler invocations are counted across both runs. */
function countedEchoRoutes(calls: { count: number }) {
    const echo = (req: { message: string }) => {
        calls.count++;
        return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
    };
    return defineService(EchoService, { echo, secureEcho: echo, rateLimitedEcho: echo });
}

function describeError(err: unknown): ReportedError {
    const connectErr = ConnectError.from(err);
    const metadata: Record<string, string> = {};
    for (const [k, v] of connectErr.metadata) {
        // Only application headers: transport framing headers differ by design.
        if (k.toLowerCase().startsWith("x-")) {
            metadata[k.toLowerCase()] = v;
        }
    }
    return { code: connectErr.code, message: connectErr.rawMessage, metadata };
}

/** A request message whose binary encoding is exactly `size` bytes (tag + 1-byte length + payload). */
function echoOfEncodedSize(size: number) {
    return create(EchoRequestSchema, { message: "x".repeat(size - 2) });
}

async function callEcho(transport: Parameters<typeof createClient>[1], message: ReturnType<typeof echoOfEncodedSize>): Promise<ParityScenarioResult> {
    try {
        const res = await createClient(EchoService, transport).echo(message);
        return { response: { message: res.message } };
    } catch (err) {
        return { error: describeError(err) };
    }
}

{
    const calls = { count: 0 };
    transportParityTest("request admission parity: a rejecting gate ends the call identically and never runs the handler", {
        services: [countedEchoRoutes(calls)],
        requestGate: () => {
            throw new ConnectError("unauthenticated", Code.Unauthenticated, { "x-gate": "credential-missing" });
        },
        scenario: async ({ transport }) => callEcho(transport, create(EchoRequestSchema, { message: "a" })),
        compare: (http, local) => {
            assert.deepStrictEqual(http.error, { code: Code.Unauthenticated, message: "unauthenticated", metadata: { "x-gate": "credential-missing" } });
            defaultCompare(http, local);
            assert.strictEqual(calls.count, 0, "the handler must not run on either transport");
        },
    });
}

{
    const calls = { count: 0 };
    transportParityTest("request admission parity: a gate throwing a plain Error ends the call as Internal without its text", {
        services: [countedEchoRoutes(calls)],
        requestGate: () => {
            throw new Error("db password=hunter2");
        },
        scenario: async ({ transport }) => callEcho(transport, create(EchoRequestSchema, { message: "a" })),
        compare: (http, local) => {
            // Connect replaces a non-ConnectError with a generic Internal error on
            // every protocol; the original message must reach neither client.
            assert.deepStrictEqual(http.error, { code: Code.Internal, message: "internal error", metadata: {} });
            defaultCompare(http, local);
            assert.strictEqual(calls.count, 0);
        },
    });
}

{
    const calls = { count: 0 };
    const gated: string[] = [];
    transportParityTest("request admission parity: an admitting gate lets the call through identically", {
        services: [countedEchoRoutes(calls)],
        requestGate: (ctx: HandlerContext) => {
            gated.push(`${ctx.service.typeName}/${ctx.method.name}`);
        },
        scenario: async ({ transport }) => callEcho(transport, create(EchoRequestSchema, { message: "a" })),
        compare: (http, local) => {
            assert.deepStrictEqual(http.response, { message: "echo:a" });
            defaultCompare(http, local);
            assert.deepStrictEqual(gated, ["echo.v1.EchoService/Echo", "echo.v1.EchoService/Echo"], "the gate must run once on each transport");
            assert.strictEqual(calls.count, 2);
        },
    });
}

{
    const calls = { count: 0 };
    transportParityTest("request admission parity: an over-limit message is ResourceExhausted on both transports, before the handler", {
        services: [countedEchoRoutes(calls)],
        readMaxBytes: 64,
        scenario: async ({ transport }) => callEcho(transport, echoOfEncodedSize(65)),
        compare: (http, local) => {
            for (const result of [http, local]) {
                assert.strictEqual(result.error?.code, Code.ResourceExhausted);
                assert.match(result.error?.message ?? "", /^message size (\d+ )?is larger than configured readMaxBytes 64$/);
            }
            defaultCompare(http, local);
            assert.strictEqual(calls.count, 0, "the handler must not run on either transport");
        },
    });
}

{
    const calls = { count: 0 };
    transportParityTest("request admission parity: a message exactly at the limit is accepted on both transports", {
        services: [countedEchoRoutes(calls)],
        readMaxBytes: 64,
        scenario: async ({ transport }) => callEcho(transport, echoOfEncodedSize(64)),
        compare: (http, local) => {
            assert.ok(http.response, "HTTP must accept a message at the limit");
            defaultCompare(http, local);
            assert.strictEqual(calls.count, 2);
        },
    });
}

// ---------------------------------------------------------------------------
// The read-limit carve-out in defaultCompare is narrow: these self-tests fail
// if it ever starts hiding a real difference.
// ---------------------------------------------------------------------------

function withError(error: ReportedError): ParityScenarioResult {
    return { error };
}

test("defaultCompare: read-limit texts that differ only by the observed size are equal", () => {
    defaultCompare(
        withError({ code: Code.ResourceExhausted, message: "message size 70 is larger than configured readMaxBytes 64" }),
        withError({ code: Code.ResourceExhausted, message: "message size is larger than configured readMaxBytes 64" }),
    );
});

test("defaultCompare: read-limit texts naming different limits still differ", () => {
    assert.throws(() =>
        defaultCompare(
            withError({ code: Code.ResourceExhausted, message: "message size 70 is larger than configured readMaxBytes 64" }),
            withError({ code: Code.ResourceExhausted, message: "message size is larger than configured readMaxBytes 65" }),
        ),
    );
});

test("defaultCompare: other ResourceExhausted messages are compared literally", () => {
    assert.throws(() =>
        defaultCompare(
            withError({ code: Code.ResourceExhausted, message: "quota exceeded for tenant a" }),
            withError({ code: Code.ResourceExhausted, message: "quota exceeded for tenant b" }),
        ),
    );
});

test("defaultCompare: the read-limit text under another code is compared literally", () => {
    assert.throws(() =>
        defaultCompare(
            withError({ code: Code.Internal, message: "message size 70 is larger than configured readMaxBytes 64" }),
            withError({ code: Code.Internal, message: "message size is larger than configured readMaxBytes 64" }),
        ),
    );
});
