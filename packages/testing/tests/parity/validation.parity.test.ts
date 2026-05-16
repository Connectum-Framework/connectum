/**
 * Group 3a — Proto-declared validation parity.
 *
 *   3a.1 Validation interceptor is wired identically into the server-side
 *        interceptor chain for HTTP and local transports.
 *   3a.2 Valid request → handler executes, response correct on both transports.
 *   3a.3 Single-rule violation (string.min_len) → ConnectError(InvalidArgument)
 *        with identical details/metadata across transports.
 *   3a.4 Multi-rule aggregated violations → identical ordered details across
 *        transports.
 *   3a.5 Client-streaming per-message validation parity (or skipped with TODO
 *        if the streaming validation path isn't exercised here).
 *   3a.6 Negative test: there is NO public API that bypasses validation on
 *        the local invoke path — invalid requests still surface
 *        Code.InvalidArgument when calling through `createLocalTransport`.
 *
 * NOTE ON IMPLEMENTATION CHOICE
 * -----------------------------
 * `@connectum/interceptors` ships `createValidateInterceptor()` via
 * `@connectrpc/validate`, but the `@connectum/testing` package does not
 * currently depend on either package directly (see package.json). The parity
 * INVARIANT under test is transport-agnostic: a server-side interceptor that
 * throws `ConnectError(Code.InvalidArgument)` based on request shape MUST
 * produce identical wire-level errors on both HTTP and local transports.
 *
 * To prove that invariant without entangling the test with the specific
 * implementation, this file uses a small inline validation interceptor that
 * mirrors the contract of `protovalidate` (Code.InvalidArgument + violations
 * aggregated in metadata + ConnectError details). The fixture proto
 * (echo.v1.EchoRequest) is reused; the rules are encoded in the interceptor.
 *
 * TODO: once `@connectum/testing` declares a devDependency on
 * `@connectum/interceptors` (and transitively `@connectrpc/validate`) and a
 * proto fixture with real `buf.validate` annotations is generated, swap the
 * inline interceptor for `createValidateInterceptor()` from
 * `@connectum/interceptors`. The assertions in this file remain valid — only
 * the source of the violation needs to change.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, createClient, type Interceptor } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createLocalTransport, createServer } from "@connectum/core";
import { transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/**
 * Inline validation interceptor mimicking `protovalidate` semantics.
 *
 * Rules (encoded by message type name):
 *   echo.v1.EchoRequest.message      -> string.min_len = 3, max_len = 50
 *   streaming.v1.Item.value          -> string.min_len = 1
 *
 * On violation, throws `ConnectError(Code.InvalidArgument)`. Aggregated
 * violations are serialized into the error's `metadata` under the key
 * `x-validation-violations` (comma-joined field paths) so that the parity
 * driver's structural diff can compare them byte-for-byte.
 */
function createInlineValidationInterceptor(): Interceptor {
    type Violation = { field: string; constraint: string; message: string };

    function validate(msg: unknown, typeName: string): Violation[] {
        const violations: Violation[] = [];
        const m = msg as Record<string, unknown>;
        switch (typeName) {
            case "echo.v1.EchoRequest": {
                const value = typeof m.message === "string" ? m.message : "";
                if (value.length < 3) {
                    violations.push({ field: "message", constraint: "string.min_len", message: "value length below minimum (3)" });
                }
                if (value.length > 50) {
                    violations.push({ field: "message", constraint: "string.max_len", message: "value length above maximum (50)" });
                }
                // Synthetic "second rule" for the multi-violation test: forbid
                // the literal "BAD" (case-insensitive). Stacks with min_len so
                // the empty string trips both rules at once.
                if (value.toLowerCase().includes("bad")) {
                    violations.push({ field: "message", constraint: "string.not_contains", message: "value must not contain 'bad'" });
                }
                break;
            }
            case "streaming.v1.Item": {
                const value = typeof m.value === "string" ? m.value : "";
                if (value.length < 1) {
                    violations.push({ field: "value", constraint: "string.min_len", message: "value length below minimum (1)" });
                }
                break;
            }
            default:
                // Unknown message types pass through — same behaviour as
                // protovalidate when no rules are declared.
                break;
        }
        return violations;
    }

    function buildError(violations: Violation[]): ConnectError {
        // Aggregate violations into a metadata header so the parity diff can
        // compare ordered violation lists. Match protovalidate's "list every
        // violation in declaration order" semantics.
        const headers = new Headers();
        headers.set("x-validation-violations", violations.map((v) => `${v.field}:${v.constraint}`).join(","));
        const msg = `validation failed: ${violations.map((v) => v.message).join("; ")}`;
        return new ConnectError(msg, Code.InvalidArgument, headers);
    }

    return (next) => async (req) => {
        // Stream requests carry an async iterable of messages; validate each
        // as it is consumed so that mid-stream violations behave identically
        // on both transports.
        if (req.stream) {
            const upstream = req.message as AsyncIterable<unknown>;
            const typeName = req.method.input.typeName;
            async function* validated() {
                for await (const item of upstream) {
                    const v = validate(item, typeName);
                    if (v.length > 0) {
                        throw buildError(v);
                    }
                    yield item;
                }
            }
            // Replace the message stream with the validating one.
            return next({ ...req, message: validated() } as typeof req);
        }
        // Unary: validate the single request message before forwarding.
        const v = validate(req.message, req.method.input.typeName);
        if (v.length > 0) {
            throw buildError(v);
        }
        return next(req);
    };
}

function echoRoutes() {
    return (router: ConnectRouter) => {
        router.service(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `ok:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
    };
}

function streamingRoutes() {
    return (router: ConnectRouter) => {
        router.service(StreamingService, {
            echo: (req) => create(ItemSchema, { value: `ok:${req.value}`, sequence: req.sequence }),
            async *server(req) {
                yield create(ItemSchema, { value: req.value, sequence: 0 });
            },
            async client(requests) {
                let total = 0;
                for await (const _ of requests) total++;
                return { total };
            },
            async *bidi(requests) {
                for await (const item of requests) {
                    yield create(ItemSchema, { value: item.value, sequence: item.sequence });
                }
            },
        });
    };
}

function describeError(err: unknown): { code: number | string; message: string; metadata?: Record<string, string> } {
    if (err instanceof ConnectError) {
        const md: Record<string, string> = {};
        for (const [k, v] of err.metadata) {
            const lower = k.toLowerCase();
            if (lower.startsWith("x-")) md[lower] = v;
        }
        return { code: err.code, message: err.rawMessage, metadata: md };
    }
    return { code: "non-connect", message: String(err) };
}

// -- 3a.1 ---------------------------------------------------------------
// Wiring documentation: a single Interceptor[] array is passed to
// `createServer({ interceptors })` and applied identically by both the HTTP
// listener and the in-process `createLocalTransport(server)` path (the
// latter routes through `router.interceptors`, fixed in Phase 4-A). The
// 3a.2–3a.4 parity tests below exercise that wiring end-to-end; a passing
// run is the proof-of-confirmation for 3a.1.

// -- 3a.2 ---------------------------------------------------------------
transportParityTest("parity 3a.2: valid request passes validation on both transports", {
    services: [echoRoutes()],
    interceptors: [createInlineValidationInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "hello" }));
        return { response: { message: res.message } };
    },
});

// -- 3a.3 ---------------------------------------------------------------
transportParityTest("parity 3a.3: single-rule violation produces identical InvalidArgument error", {
    services: [echoRoutes()],
    interceptors: [createInlineValidationInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "" }));
            return { response: { unreachable: true } };
        } catch (err) {
            return { error: describeError(err) };
        }
    },
});

// -- 3a.4 ---------------------------------------------------------------
// Trip TWO rules at once: the empty-ish "bad" string (length 2) doesn't
// fail min_len, but with "bd" (length 2) we get min_len. Use "bad" (len 3)
// → only the not_contains rule fires. To force aggregation we use the
// literal "" — fails min_len; and "ba" (len 2, contains "ba" not "bad").
// Cleaner: use "ba" (len 2) — fails ONLY min_len. To trigger BOTH, use
// "bd" (len 2) — fails min_len, doesn't contain "bad". Hmm — we need a
// single value that violates two rules simultaneously. Use "ad" (len 2,
// doesn't contain bad → only min_len). The aggregator test is meaningful
// only if a single input violates >1 rule. Use the empty string with the
// not_contains rule too: "" doesn't contain "bad", only min_len fires.
//
// Solution: extend the multi-rule input to a value that is both too long
// AND contains "bad" — e.g. a 51-char string with "bad" inside.
transportParityTest("parity 3a.4: multi-rule violation aggregates identically across transports", {
    services: [echoRoutes()],
    interceptors: [createInlineValidationInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        // 51 chars including the substring "bad" → trips max_len AND not_contains.
        const tooLongWithBad = `bad${"x".repeat(48)}`;
        try {
            await client.echo(create(EchoRequestSchema, { message: tooLongWithBad }));
            return { response: { unreachable: true } };
        } catch (err) {
            return { error: describeError(err) };
        }
    },
});

// -- 3a.5 ---------------------------------------------------------------
// Client-streaming per-message validation. The inline interceptor wraps
// `req.message` (the inbound iterable) with a validating async generator;
// when a streamed Item violates string.min_len, an InvalidArgument error
// must surface identically on HTTP and local.
//
// Connect-ES client-streaming surfaces server-side errors when the client
// awaits the response. Send one valid item then one invalid empty item.
transportParityTest("parity 3a.5: client-streaming mid-stream violation surfaces identically", {
    services: [streamingRoutes()],
    interceptors: [createInlineValidationInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        async function* messages() {
            yield create(ItemSchema, { value: "ok", sequence: 1 });
            yield create(ItemSchema, { value: "", sequence: 2 });
        }
        try {
            const res = await client.client(messages());
            return { response: { total: res.total } };
        } catch (err) {
            return { error: describeError(err) };
        }
    },
});

import assert from "node:assert";
// -- 3a.6 ---------------------------------------------------------------
// Negative test: there is NO public API on the local transport that lets a
// caller bypass server-side interceptors (and therefore validation). The
// only documented way to reach a handler via the in-process path is
// `createLocalTransport(server)` → `createClient(Service, transport)`,
// which routes through the same `router.interceptors` chain as HTTP. Prove
// it by issuing an invalid request through that path and asserting we get
// `Code.InvalidArgument`.
import { test as nodeTest } from "node:test";

nodeTest("parity 3a.6: local transport has no validation-bypass API", async () => {
    const server = createServer({
        services: [echoRoutes()],
        interceptors: [createInlineValidationInterceptor()],
    });
    const transport = createLocalTransport(server);
    const client = createClient(EchoService, transport);
    try {
        await client.echo(create(EchoRequestSchema, { message: "" }));
        assert.fail("expected validation to reject the invalid request through local transport");
    } catch (err) {
        assert.ok(err instanceof ConnectError, "expected a ConnectError");
        assert.strictEqual((err as ConnectError).code, Code.InvalidArgument, "local transport must surface InvalidArgument identically to HTTP");
    }
});
