/**
 * Proto-declared authentication and authorization parity, on the shipped
 * interceptors.
 *
 * The server chain is the documented one: `createErrorHandlerInterceptor()` →
 * `createJwtAuthInterceptor()` → `createProtoAuthzInterceptor()`. The access rules are
 * real `connectum.auth.v1` options in `tests/fixtures/authz`: `SecureEcho` requires
 * the `echo:read` scope and `PublicEcho` is public, with `skipMethods` taken from the
 * descriptors by `getPublicMethods()`. Nothing in this file imitates an interceptor;
 * a test that drove a stand-in would stay green while the shipped one changed what a
 * client receives.
 *
 * Each scenario checks the outcome against a literal (not only "HTTP equals local",
 * which two identically broken transports would also satisfy) and then compares the
 * two transports. This suite lives in `@connectum/auth` rather than
 * `@connectum/testing` because `@connectum/testing` cannot depend on the package
 * that already depends on it.
 */

import assert from "node:assert";
import { test as nodeTest } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createLocalTransport, createServer, defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor, createProtoAuthzInterceptor, getAuthContext } from "../../src/index.ts";
import { getPublicMethods } from "../../src/proto/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

function routes() {
    const reply = (message: string) => create(EchoResponseSchema, { message, subject: getAuthContext()?.subject ?? "" });
    return defineService(AuthzService, {
        secureEcho: (req) => reply(`secure:${req.message}`),
        publicEcho: (req) => reply(`public:${req.message}`),
    });
}

/** The documented chain: errors sanitized, JWT verified, then proto-declared access rules. */
function shippedChain() {
    return [
        createErrorHandlerInterceptor({ logErrors: false }),
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, skipMethods: getPublicMethods([AuthzService]) }),
        createProtoAuthzInterceptor({ defaultPolicy: "deny" }),
    ];
}

/** A signed token for `subject` carrying the given space-separated scopes. */
function bearer(subject: string, scope: string): Promise<string> {
    return createTestJwt({ sub: subject, scope }).then((token) => `Bearer ${token}`);
}

/** What a client sees of a rejection: code, text, details and every custom response header. */
function describeRejection(err: unknown): NonNullable<ParityScenarioResult["error"]> {
    if (!(err instanceof ConnectError)) {
        return { code: "non-connect", message: String(err) };
    }
    const metadata: Record<string, string> = {};
    for (const [key, value] of err.metadata) {
        const lower = key.toLowerCase();
        if (lower.startsWith("x-")) metadata[lower] = value;
    }
    const details = err.details.map((detail) => {
        if ("desc" in detail) {
            throw new Error(`detail ${detail.desc.typeName} arrived as an outgoing detail; a client receives only wire details`);
        }
        return { type: detail.type, base64: Buffer.from(detail.value).toString("base64") };
    });
    return { code: err.code, message: err.rawMessage, details, metadata };
}

/** Rejection oracle: both transports reject with `code` and `message`, no detail leaks, and the errors are equal. */
function expectRejectionOnBothTransports(code: Code, message: string) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.ok(result.error, `${name} transport must surface an error`);
            assert.strictEqual(result.error.code, code, `${name} transport must reject with code ${code}`);
            assert.strictEqual(result.error.message, message, `${name} transport must deliver the rejection text`);
            assert.deepStrictEqual(result.error.details, [], `${name} transport must not attach details to an authentication or authorization rejection`);
        }
        defaultCompare(http, local);
    };
}

transportParityTest("parity: valid token with the required scope reaches the handler with its verified subject on both transports", {
    services: [routes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(AuthzService, transport);
        const res = await client.secureEcho(create(EchoRequestSchema, { message: "hello" }), {
            headers: { authorization: await bearer("alice", "echo:read echo:write") },
        });
        return { response: { message: res.message, subject: res.subject } };
    },
    // The subject proves authentication ran and its context reached the handler: with the
    // chain skipped on a transport the call would succeed too, but the subject would be empty.
    compare: (http, local) => {
        const expected = { message: "secure:hello", subject: "alice" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must verify the token and expose the subject to the handler");
        assert.deepStrictEqual(local.response, expected, "Local transport must verify the token and expose the subject to the handler");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: protected method without authorization is Unauthenticated on both transports", {
    services: [routes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(AuthzService, transport);
        try {
            await client.secureEcho(create(EchoRequestSchema, { message: "hello" }));
            throw new Error("expected the missing credentials to be rejected, but the call succeeded");
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectRejectionOnBothTransports(Code.Unauthenticated, "Missing credentials"),
});

transportParityTest("parity: valid token without the required scope is PermissionDenied on both transports", {
    services: [routes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(AuthzService, transport);
        try {
            await client.secureEcho(create(EchoRequestSchema, { message: "hello" }), {
                headers: { authorization: await bearer("bob", "other:scope") },
            });
            throw new Error("expected the missing scope to be rejected, but the call succeeded");
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectRejectionOnBothTransports(Code.PermissionDenied, "Access denied"),
});

transportParityTest("parity: public method without authorization is served anonymously on both transports", {
    services: [routes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(AuthzService, transport);
        const res = await client.publicEcho(create(EchoRequestSchema, { message: "hi" }));
        return { response: { message: res.message, subject: res.subject } };
    },
    // An empty subject is the anonymous caller: the public method is served and no
    // identity is invented for it.
    compare: (http, local) => {
        const expected = { message: "public:hi", subject: "" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must serve the public method anonymously");
        assert.deepStrictEqual(local.response, expected, "Local transport must serve the public method anonymously");
        defaultCompare(http, local);
    },
});

// The only documented way into a handler in-process is `createLocalTransport(server)`,
// which runs the same server interceptors as HTTP. Each rejection must survive it, and a
// caller that holds the scope must still be served, so the rejections come from the
// rules and not from the local transport refusing every call.
nodeTest("parity: local transport has no authentication or authorization bypass", async () => {
    const server = createServer({ services: [routes()], interceptors: shippedChain() });
    const client = createClient(AuthzService, createLocalTransport(server));

    await assert.rejects(client.secureEcho(create(EchoRequestSchema, { message: "x" })), (err: unknown) => {
        assert.ok(err instanceof ConnectError, "expected a ConnectError");
        assert.strictEqual(err.code, Code.Unauthenticated, "missing credentials must be rejected in-process");
        return true;
    });

    await assert.rejects(
        client.secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: { authorization: await bearer("bob", "other:scope") },
        }),
        (err: unknown) => {
            assert.ok(err instanceof ConnectError, "expected a ConnectError");
            assert.strictEqual(err.code, Code.PermissionDenied, "a missing scope must be rejected in-process");
            return true;
        },
    );

    const allowed = await client.secureEcho(create(EchoRequestSchema, { message: "x" }), {
        headers: { authorization: await bearer("alice", "echo:read") },
    });
    assert.strictEqual(allowed.message, "secure:x");
    assert.strictEqual(allowed.subject, "alice");
});
