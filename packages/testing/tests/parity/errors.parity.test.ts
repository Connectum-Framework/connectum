/**
 * Group 5 — Error mapping parity.
 *
 * Verifies that errors thrown by handlers and server-side interceptors are
 * mapped identically across HTTP and in-process transports:
 *   5.1 ConnectError(NotFound) with metadata round-trip
 *   5.2 plain Error -> Code.Internal, text not disclosed
 *   5.3 server interceptor throw -> identical mapping
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/**
 * Build an explicit error-oracle `compare` callback (see authorization.parity
 * for rationale). Prevents the false-positive where BOTH transports
 * unexpectedly succeed and the placeholder payload is silently compared equal.
 */
function expectErrorOnBothTransports(expectedCode: Code) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        assert.ok(http.error, "HTTP transport must surface an error");
        assert.ok(local.error, "Local transport must surface an error");
        assert.strictEqual(http.error.code, expectedCode, `HTTP transport error code must be ${expectedCode}`);
        assert.strictEqual(local.error.code, expectedCode, `Local transport error code must be ${expectedCode}`);
        defaultCompare(http, local);
    };
}

function notFoundRoutes() {
    return defineService(EchoService, {
        echo: () => {
            const headers = new Headers();
            headers.set("x-error-tag", "user-42");
            throw new ConnectError("missing record", Code.NotFound, headers);
        },
        secureEcho: () => {
            throw new ConnectError("nope", Code.NotFound);
        },
        rateLimitedEcho: () => {
            throw new ConnectError("nope", Code.NotFound);
        },
    });
}

/** Text of the failure a handler throws that is not a ConnectError; it must never reach a client. */
const PLAIN_ERROR_TEXT = "secret-token-9f3a";

function plainErrorRoutes() {
    return defineService(EchoService, {
        echo: () => {
            throw new Error(PLAIN_ERROR_TEXT);
        },
        secureEcho: () => {
            throw new Error(PLAIN_ERROR_TEXT);
        },
        rateLimitedEcho: () => {
            throw new Error(PLAIN_ERROR_TEXT);
        },
    });
}

function passthroughRoutes() {
    return defineService(EchoService, {
        echo: () => {
            throw new Error("should not be reached");
        },
        secureEcho: () => {
            throw new Error("should not be reached");
        },
        rateLimitedEcho: () => {
            throw new Error("should not be reached");
        },
    });
}

const throwingInterceptor: Interceptor = () => () => {
    throw new ConnectError("interceptor reject", Code.PermissionDenied);
};

function describeError(err: unknown): { code: number | string; message: string; metadata?: Record<string, string> } {
    if (err instanceof ConnectError) {
        const md: Record<string, string> = {};
        for (const [k, v] of err.metadata) {
            // Strip transport-specific noise (content-type, trailers framing).
            const lower = k.toLowerCase();
            if (lower.startsWith("x-")) {
                md[lower] = v;
            }
        }
        return {
            code: err.code,
            message: err.rawMessage,
            metadata: md,
        };
    }
    return { code: "non-connect", message: String(err) };
}

// 5.1 — ConnectError(NotFound) with metadata.
transportParityTest("parity 5.1: ConnectError(NotFound) maps identically with metadata", {
    services: [notFoundRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "x" }));
            throw new Error("expected handler to throw ConnectError(NotFound), but call succeeded");
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    compare: expectErrorOnBothTransports(Code.NotFound),
});

// A failure that is not a ConnectError: code `internal`, the same message on both
// transports, and the original text reaches neither client.
transportParityTest("parity: a failure that is not a ConnectError maps to internal identically and its text is not disclosed", {
    services: [plainErrorRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "x" }));
            return { response: { unreachable: true } };
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    // The protocols leave the message of an unhandled failure open, so the literal
    // is not pinned here; what is pinned is that both paths agree and disclose nothing.
    compare: (http, local) => {
        assert.ok(http.error, "HTTP transport must surface an error");
        assert.ok(local.error, "Local transport must surface an error");
        assert.strictEqual(http.error.code, Code.Internal, "HTTP transport error code must be Internal");
        assert.strictEqual(local.error.code, Code.Internal, "Local transport error code must be Internal");
        assert.strictEqual(local.error.message, http.error.message, "both transports must report the same message");
        for (const [transport, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.ok(!JSON.stringify(result.error).includes(PLAIN_ERROR_TEXT), `${transport} error must not contain the original text`);
        }
    },
});

// 5.3 — Server-side interceptor throws → identical mapping.
transportParityTest("parity 5.3: server interceptor error maps identically", {
    services: [passthroughRoutes()],
    interceptors: [throwingInterceptor],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "x" }));
            throw new Error("expected interceptor to reject the call, but it succeeded");
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    compare: expectErrorOnBothTransports(Code.PermissionDenied),
});
