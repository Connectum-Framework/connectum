/**
 * Group 3b — Proto-declared authorization parity.
 *
 *   3b.1 Auth/authz interceptors are wired identically into the server-side
 *        interceptor chain for HTTP and local transports.
 *   3b.2 Protected method, valid bearer token with required scope → success
 *        on both transports.
 *   3b.3 Protected method, NO authorization header → ConnectError(Unauthenticated)
 *        with identical metadata.
 *   3b.4 Protected method, valid token WITHOUT required scope → ConnectError
 *        (PermissionDenied) with identical metadata.
 *   3b.5 Public method, no auth header → success on both transports.
 *   3b.6 Negative test: there is NO public API that bypasses authz on the
 *        local invoke path.
 *
 * NOTE ON IMPLEMENTATION CHOICE
 * -----------------------------
 * `@connectum/auth` exposes `createAuthInterceptor` + `createAuthzInterceptor`
 * (declarative rules) and `createProtoAuthzInterceptor` (proto-options-driven).
 * `@connectum/testing` does not currently depend on `@connectum/auth`, so we
 * encode the same enforcement contract inline:
 *
 *   - Missing/invalid `authorization` header  → Code.Unauthenticated
 *   - Token missing the method's required scope → Code.PermissionDenied
 *   - Public method (not in the protected map)   → bypass auth entirely
 *
 * The "proto-declared" aspect is represented by a static `methodScopes` map
 * keyed on `${service}/${method}` — semantically equivalent to a proto-option
 * extension annotated on each RPC. The parity INVARIANT being tested is
 * transport-agnostic: identical interceptor chain → identical error shape on
 * both transports.
 *
 * TODO: once `@connectum/testing` declares a devDependency on `@connectum/auth`,
 * swap the inline interceptor for `createAuthInterceptor` +
 * `createAuthzInterceptor` (or `createProtoAuthzInterceptor` with a fixture
 * proto carrying real `(connectum.auth.required_scope) = "..."` options). The
 * assertions in this file remain valid — only the source of the rejection
 * needs to change.
 */

import assert from "node:assert";
import { test as nodeTest } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createLocalTransport, createServer, defineService } from "@connectum/core";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/**
 * Build an explicit error-oracle `compare` callback for parity scenarios that
 * MUST fail with a specific `Code`.
 *
 * The default structural diff over `ParityScenarioResult` can silently pass if
 * BOTH transports unexpectedly return a placeholder success payload (e.g.
 * `{ response: { unreachable: true } }`). This oracle prevents that
 * false-positive by asserting that an error was captured on each side, that
 * both errors carry the expected `Code`, and finally delegating to the
 * structural diff to compare message + metadata.
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

/**
 * Proto-declared scope requirements (semantic equivalent of
 * `option (connectum.auth.required_scope) = "..."` on each RPC).
 *
 * Methods not listed here are PUBLIC.
 */
const methodScopes: Record<string, string> = {
    "echo.v1.EchoService/SecureEcho": "echo:read",
    // `Echo` and `RateLimitedEcho` are public — absent from this map.
};

interface TestAuthContext {
    readonly subject: string;
    readonly scopes: readonly string[];
}

/**
 * Inline auth + authz interceptor.
 *
 * Token format: `Bearer <subject>|<scope1>,<scope2>,...` (synthetic, just
 * enough to drive the parity assertions). Real deployments would plug in
 * `createJwtAuthInterceptor` or `createAuthInterceptor` from `@connectum/auth`.
 */
function createInlineAuthInterceptor(): Interceptor {
    function parseToken(token: string | null): TestAuthContext | null {
        if (!token) return null;
        const m = /^Bearer\s+(.+)$/.exec(token);
        if (!m) return null;
        const [subject, scopesRaw = ""] = m[1]!.split("|");
        if (!subject) return null;
        const scopes = scopesRaw ? scopesRaw.split(",").filter(Boolean) : [];
        return { subject, scopes };
    }

    function buildError(message: string, code: Code, metaKey: string, metaValue: string): ConnectError {
        const headers = new Headers();
        headers.set(metaKey, metaValue);
        return new ConnectError(message, code, headers);
    }

    return (next) => async (req) => {
        const methodKey = `${req.service.typeName}/${req.method.name}`;
        const requiredScope = methodScopes[methodKey];

        // Public method — bypass auth entirely (matches `skipMethods` /
        // "no proto-option" semantics in @connectum/auth).
        if (!requiredScope) {
            return next(req);
        }

        const authHeader = req.header.get("authorization");
        const ctx = parseToken(authHeader);
        if (!ctx) {
            throw buildError("Missing or malformed credentials", Code.Unauthenticated, "x-authn-reason", "missing-credentials");
        }

        if (!ctx.scopes.includes(requiredScope)) {
            throw buildError(`Access denied: scope '${requiredScope}' required`, Code.PermissionDenied, "x-authz-required-scope", requiredScope);
        }

        return next(req);
    };
}

function echoRoutes() {
    return defineService(EchoService, {
        echo: (req) => create(EchoResponseSchema, { message: `public:${req.message}`, timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: `secure:${req.message}`, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: `public:${req.message}`, timestamp: 0n }),
    });
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

// -- 3b.1 ---------------------------------------------------------------
// Wiring documentation: identical to 3a.1 — the same Interceptor[] feeds
// both transports via `createServer({ interceptors })`. The parity passes
// below (3b.2–3b.5) are the proof-of-confirmation.

// -- 3b.2 ---------------------------------------------------------------
transportParityTest("parity 3b.2: protected method with valid token + scope succeeds on both transports", {
    services: [echoRoutes()],
    interceptors: [createInlineAuthInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.secureEcho(create(EchoRequestSchema, { message: "hello" }), {
            headers: { authorization: "Bearer alice|echo:read,echo:write" },
        });
        return { response: { message: res.message } };
    },
});

// -- 3b.3 ---------------------------------------------------------------
transportParityTest("parity 3b.3: protected method without authorization → Unauthenticated identically", {
    services: [echoRoutes()],
    interceptors: [createInlineAuthInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.secureEcho(create(EchoRequestSchema, { message: "hello" }));
            // A successful return here is a contract violation on BOTH
            // transports (authz must have rejected). Throw so the test fails
            // loudly instead of producing a placeholder payload that the
            // structural diff could mis-compare as "identical success".
            throw new Error("expected authz to reject missing credentials, but call succeeded");
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    compare: expectErrorOnBothTransports(Code.Unauthenticated),
});

// -- 3b.4 ---------------------------------------------------------------
transportParityTest("parity 3b.4: protected method with token but no required scope → PermissionDenied identically", {
    services: [echoRoutes()],
    interceptors: [createInlineAuthInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        try {
            await client.secureEcho(create(EchoRequestSchema, { message: "hello" }), {
                headers: { authorization: "Bearer alice|wrong:scope" },
            });
            throw new Error("expected authz to reject insufficient scope, but call succeeded");
        } catch (err) {
            return { error: describeError(err) };
        }
    },
    compare: expectErrorOnBothTransports(Code.PermissionDenied),
});

// -- 3b.5 ---------------------------------------------------------------
transportParityTest("parity 3b.5: public method without auth header succeeds on both transports", {
    services: [echoRoutes()],
    interceptors: [createInlineAuthInterceptor()],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "hi" }));
        return { response: { message: res.message } };
    },
});

// -- 3b.6 ---------------------------------------------------------------
// Negative test: the only documented in-process entry point is
// `createLocalTransport(server)`, which routes through the same
// `router.interceptors` chain as HTTP. There is no public API to dispatch
// to a service handler skipping the interceptor chain.
nodeTest("parity 3b.6: local transport has no authz-bypass API", async () => {
    const server = createServer({
        services: [echoRoutes()],
        interceptors: [createInlineAuthInterceptor()],
    });
    const transport = createLocalTransport(server);
    const client = createClient(EchoService, transport);

    // Missing credentials → Unauthenticated.
    try {
        await client.secureEcho(create(EchoRequestSchema, { message: "x" }));
        assert.fail("expected authz to reject missing credentials through local transport");
    } catch (err) {
        assert.ok(err instanceof ConnectError, "expected a ConnectError");
        assert.strictEqual((err as ConnectError).code, Code.Unauthenticated, "local transport must surface Unauthenticated identically to HTTP");
    }

    // Wrong scope → PermissionDenied.
    try {
        await client.secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: { authorization: "Bearer bob|other:scope" },
        });
        assert.fail("expected authz to reject insufficient scope through local transport");
    } catch (err) {
        assert.ok(err instanceof ConnectError, "expected a ConnectError");
        assert.strictEqual((err as ConnectError).code, Code.PermissionDenied, "local transport must surface PermissionDenied identically to HTTP");
    }
});
