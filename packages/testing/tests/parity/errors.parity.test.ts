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
import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/**
 * Build an explicit error-oracle `compare` callback. Prevents the false-positive
 * where BOTH transports unexpectedly succeed and the placeholder payload is
 * silently compared equal.
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
    // A handler-thrown ConnectError reaches the client with its own message and
    // its metadata headers on both transports; the expected values are the ones
    // the handler throws, not whatever the two transports happen to agree on.
    compare: (http, local) => {
        expectErrorOnBothTransports(Code.NotFound)(http, local);
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.error?.message, "missing record", `${name} transport must deliver the handler's message`);
            assert.strictEqual(result.error?.metadata?.["x-error-tag"], "user-42", `${name} transport must deliver the handler's metadata header`);
        }
    },
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

// Error details: a ConnectError thrown with outgoing details delivers those details, in order,
// on both transports. `describeError` above does not collect them, so this scenario does.
transportParityTest("parity: ConnectError details reach the client in order on both transports", {
    services: [
        defineService(EchoService, {
            echo: () => {
                throw new ConnectError("rejected with details", Code.FailedPrecondition, undefined, [
                    { desc: EchoResponseSchema, value: create(EchoResponseSchema, { message: "detail-one", timestamp: 1n }) },
                    { desc: EchoResponseSchema, value: create(EchoResponseSchema, { message: "detail-two", timestamp: 2n }) },
                ]);
            },
            secureEcho: () => {
                throw new Error("should not be reached");
            },
            rateLimitedEcho: () => {
                throw new Error("should not be reached");
            },
        }),
    ],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "x" }));
            return { response: { unreachable: true } };
        } catch (err) {
            const connectErr = ConnectError.from(err);
            return {
                error: {
                    code: connectErr.code,
                    message: connectErr.rawMessage,
                    details: connectErr.findDetails(EchoResponseSchema).map((detail) => ({ message: detail.message, timestamp: detail.timestamp.toString() })),
                },
            };
        }
    },
    compare: (http, local) => {
        const expected = [
            { message: "detail-one", timestamp: "1" },
            { message: "detail-two", timestamp: "2" },
        ];
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.error?.code, Code.FailedPrecondition, `${name} transport error code`);
            assert.strictEqual(result.error?.message, "rejected with details", `${name} transport error message`);
            assert.deepStrictEqual(result.error?.details, expected, `${name} transport must deliver both details, in order`);
        }
        defaultCompare(http, local);
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
    // The interceptor's own code and message reach the client unchanged on both
    // transports (the handler is never reached).
    compare: (http, local) => {
        expectErrorOnBothTransports(Code.PermissionDenied)(http, local);
        assert.strictEqual(http.error?.message, "interceptor reject", "HTTP transport must deliver the interceptor's message");
        assert.strictEqual(local.error?.message, "interceptor reject", "local transport must deliver the interceptor's message");
    },
});

/** Runs the plain-error handler through the client of whichever transport the harness provides. */
async function plainErrorScenario(transport: Parameters<typeof createClient>[1]): Promise<ParityScenarioResult> {
    const client = createClient(EchoService, transport);
    try {
        await client.echo(create(EchoRequestSchema, { message: "x" }));
        return { response: { unreachable: true } };
    } catch (err) {
        return { error: describeError(err) };
    }
}

// With the default chain (errorHandler first) the failure text is replaced by the fixed
// text "internal error" on both transports. The test above runs with no interceptors and so
// only shows Connect-ES's own protection; this one proves the Connectum chain gives the same
// guarantee and pins the literal. Oracle: CWE-209 and the Connect protocol documentation.
transportParityTest("parity: default interceptors send internal / \"internal error\" for a failure that is not a ConnectError", {
    services: [plainErrorRoutes()],
    interceptors: createDefaultInterceptors({ errorHandler: { logErrors: false } }),
    scenario: ({ transport }) => plainErrorScenario(transport),
    compare: (http, local) => {
        assert.ok(http.error, "HTTP transport must surface an error");
        assert.ok(local.error, "Local transport must surface an error");
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.error?.code, Code.Internal, `${name} error code must be Internal`);
            assert.strictEqual(result.error?.message, "internal error", `${name} error text must be the generic text`);
            assert.ok(!JSON.stringify(result.error).includes(PLAIN_ERROR_TEXT), `${name} error must not contain the original text`);
        }
        defaultCompare(http, local);
    },
});

// The opt-in sends the original text, and sends the same text on both transports.
transportParityTest("parity: exposeErrorMessages sends the original text identically on both transports", {
    services: [plainErrorRoutes()],
    interceptors: [createErrorHandlerInterceptor({ exposeErrorMessages: true, logErrors: false })],
    scenario: ({ transport }) => plainErrorScenario(transport),
    compare: (http, local) => {
        assert.ok(http.error, "HTTP transport must surface an error");
        assert.ok(local.error, "Local transport must surface an error");
        assert.strictEqual(http.error.code, Code.Internal, "HTTP transport error code must be Internal");
        assert.strictEqual(local.error.code, Code.Internal, "Local transport error code must be Internal");
        assert.strictEqual(http.error.message, PLAIN_ERROR_TEXT, "HTTP transport must send the original text");
        assert.strictEqual(local.error.message, PLAIN_ERROR_TEXT, "local transport must send the original text");
        defaultCompare(http, local);
    },
});

// A reporting hook that fails (a metrics sink that is down) must not change what the client
// receives: the handler's own ConnectError arrives with its text and metadata on both transports.
for (const [label, onError] of [
    [
        "throws",
        () => {
            throw new Error("metrics sink down");
        },
    ],
    ["rejects", () => Promise.reject(new Error("async sink down"))],
] as const) {
    transportParityTest(`parity: an onError that ${label} leaves the handler's ConnectError untouched on both transports`, {
        services: [notFoundRoutes()],
        interceptors: [createErrorHandlerInterceptor({ logErrors: false, onError })],
        scenario: async ({ transport }) => {
            const client = createClient(EchoService, transport);
            try {
                await client.echo(create(EchoRequestSchema, { message: "x" }));
                throw new Error("expected handler to throw ConnectError(NotFound), but call succeeded");
            } catch (err) {
                return { error: describeError(err) };
            }
        },
        compare: (http, local) => {
            expectErrorOnBothTransports(Code.NotFound)(http, local);
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                assert.strictEqual(result.error?.message, "missing record", `${name} transport must deliver the handler's message`);
                assert.strictEqual(result.error?.metadata?.["x-error-tag"], "user-42", `${name} transport must deliver the handler's metadata header`);
            }
        },
    });
}

// A SanitizableError whose `code` is not a failure code (1..16) reaches both transports as
// `internal` with its clientMessage; the server details stay on the server.
transportParityTest("parity: a SanitizableError with an invalid code maps to internal with its clientMessage on both transports", {
    services: [
        defineService(EchoService, {
            echo: () => {
                throw Object.assign(new Error("secret-detail-4c1d"), { clientMessage: "safe text", serverDetails: { table: "users" }, code: 99 });
            },
            secureEcho: () => {
                throw new Error("should not be reached");
            },
            rateLimitedEcho: () => {
                throw new Error("should not be reached");
            },
        }),
    ],
    interceptors: [createErrorHandlerInterceptor({ logErrors: false })],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "x" }));
            return { response: { unreachable: true } };
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    compare: (http, local) => {
        expectErrorOnBothTransports(Code.Internal)(http, local);
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.strictEqual(result.error?.message, "safe text", `${name} transport must deliver the clientMessage`);
            assert.ok(!JSON.stringify(result.error).includes("secret-detail-4c1d"), `${name} transport must not disclose the original text`);
        }
    },
});
