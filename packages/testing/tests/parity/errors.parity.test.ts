/**
 * Group 5 — Error mapping parity.
 *
 * Verifies that errors thrown by handlers and server-side interceptors are
 * mapped identically across HTTP and in-process transports:
 *   5.1 ConnectError(NotFound) with metadata round-trip
 *   5.2 plain Error -> Code.Internal
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

function plainErrorRoutes() {
    return defineService(EchoService, {
        echo: () => {
            throw new Error("boom");
        },
        secureEcho: () => {
            throw new Error("boom");
        },
        rateLimitedEcho: () => {
            throw new Error("boom");
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

// 5.2 — plain Error → Code.Internal, message contains "boom".
transportParityTest("parity 5.2: plain Error maps to Code.Internal with same message shape", {
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
    // Both transports normalize plain Error to Code.Internal; rawMessage often
    // becomes the original "boom". Compare only code + message containment.
    compare: (http, local) => {
        if (!http.error || !local.error) {
            throw new Error("expected both runs to error");
        }
        if (http.error.code !== local.error.code) {
            throw new Error(`error code mismatch: http=${http.error.code} local=${local.error.code}`);
        }
        if (http.error.code !== Code.Internal) {
            throw new Error(`expected Code.Internal on http, got ${http.error.code}`);
        }
        // Both transports normalize the rawMessage of an opaque plain Error
        // to ConnectRPC's default "internal error" string (the original
        // "boom" text is intentionally not leaked to wire). The contract is
        // that this normalization happens identically on both paths.
        if (http.error.message !== local.error.message) {
            throw new Error(`expected identical normalized message; http="${http.error.message}" local="${local.error.message}"`);
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
