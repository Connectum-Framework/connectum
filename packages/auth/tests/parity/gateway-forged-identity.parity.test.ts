/**
 * A client cannot plant identity headers behind the gateway interceptor, on both transports.
 *
 * The server chain is the shipped one: `createErrorHandlerInterceptor()` then
 * `createGatewayAuthInterceptor({ propagateHeaders: true })`. The handler reports exactly
 * which `x-auth-*` headers reached it, which is what a downstream hop (or a header-forwarding
 * `propagateHeaders` list) would copy. A user whose verified identity has no roles, scopes,
 * name or claims must reach it with none of those headers, whatever the client sent: the
 * interceptor writes only the fields the identity has, so a client value for an absent
 * field would survive unless the interceptor removes it.
 *
 * The final scenario runs a real two-hop chain over sockets: edge A verifies the user and
 * forwards `x-auth-*` to service B, which trusts them through a shared secret. A forged
 * value must not turn a role-less user into an admin at B, and the legitimate chain must
 * keep working.
 */

import assert from "node:assert";
import { test as nodeTest } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { AUTH_HEADERS, createGatewayAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

const IDENTITY_HEADER_NAMES = Object.values(AUTH_HEADERS);
const EDGE_SECRET = "edge-secret";
const FORGED = {
    "x-auth-roles": '["admin"]',
    "x-auth-scopes": "admin:all",
    "x-auth-name": "Spoofed",
    "x-auth-claims": '{"suspended":false,"tenant":"victim"}',
    "x-auth-subject": "root",
    "x-auth-type": "forged",
} as const;

/** Reports the identity headers the handler received, as JSON in `message`. */
function reportingRoutes() {
    return defineService(AuthzService, {
        secureEcho: (_req, ctx) => reply(ctx.requestHeader),
        publicEcho: (_req, ctx) => reply(ctx.requestHeader),
    });
}

/** Response that lists the identity headers present on the request the handler received. */
function reply(headers: Headers) {
    const seen: Record<string, string> = {};
    for (const name of IDENTITY_HEADER_NAMES) {
        const value = headers.get(name);
        if (value !== null) seen[name] = value;
    }
    return create(EchoResponseSchema, { message: JSON.stringify(seen), subject: getAuthContext()?.subject ?? "" });
}

/** Server chain of the edge: error handler, then the gateway interceptor reading `x-user-*`. */
function edgeChain(propagateHeaders: boolean) {
    return [
        createErrorHandlerInterceptor({ logErrors: false }),
        createGatewayAuthInterceptor({
            headerMapping: { subject: "x-user-id", roles: "x-user-roles" },
            trustSource: { header: "x-edge-secret", expectedValues: [EDGE_SECRET] },
            propagateHeaders,
            skipMethods: ["authz.v1.AuthzService/PublicEcho"],
        }),
    ];
}

/** Headers of a legitimate edge request for the user `erin`, plus whatever the attack adds. */
function parityHeaders(extra: Record<string, string>): Record<string, string> {
    return { "x-edge-secret": EDGE_SECRET, "x-user-id": "erin", ...extra };
}

transportParityTest("parity: forged x-auth-* headers do not survive for an identity without roles, scopes, name or claims", {
    services: [reportingRoutes()],
    interceptors: edgeChain(true),
    scenario: async ({ transport }) => {
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: parityHeaders(FORGED),
        });
        return { response: { seen: JSON.parse(res.message), subject: res.subject } };
    },
    // Only the fields the verified identity actually has are present, and all carry the verified values.
    compare: (http, local) => {
        const expected = { seen: { "x-auth-subject": "erin", "x-auth-type": "gateway" }, subject: "erin" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must forward the verified identity only");
        assert.deepStrictEqual(local.response, expected, "Local transport must forward the verified identity only");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: forged x-auth-* headers do not reach the handler when propagation is off", {
    services: [reportingRoutes()],
    interceptors: edgeChain(false),
    scenario: async ({ transport }) => {
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: parityHeaders(FORGED),
        });
        return { response: { seen: JSON.parse(res.message), subject: res.subject } };
    },
    compare: (http, local) => {
        const expected = { seen: {}, subject: "erin" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must not forward client-supplied identity headers");
        assert.deepStrictEqual(local.response, expected, "Local transport must not forward client-supplied identity headers");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: forged x-auth-* headers do not reach a method skipped by the gateway interceptor", {
    services: [reportingRoutes()],
    interceptors: edgeChain(true),
    scenario: async ({ transport }) => {
        const res = await createClient(AuthzService, transport).publicEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: FORGED,
        });
        return { response: { seen: JSON.parse(res.message), subject: res.subject } };
    },
    compare: (http, local) => {
        const expected = { seen: {}, subject: "" };
        assert.deepStrictEqual(http.response, expected, "HTTP transport must strip identity headers on a skipped method");
        assert.deepStrictEqual(local.response, expected, "Local transport must strip identity headers on a skipped method");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: an identity with roles forwards its own roles and ignores a forged role list", {
    services: [reportingRoutes()],
    interceptors: edgeChain(true),
    scenario: async ({ transport }) => {
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: parityHeaders({ "x-user-roles": '["reader"]', "x-auth-roles": '["admin"]', "x-auth-scopes": "admin:all" }),
        });
        return { response: { seen: JSON.parse(res.message) } };
    },
    compare: (http, local) => {
        const expected = { seen: { "x-auth-subject": "erin", "x-auth-type": "gateway", "x-auth-roles": '["reader"]' } };
        assert.deepStrictEqual(http.response, expected);
        assert.deepStrictEqual(local.response, expected);
        defaultCompare(http, local);
    },
});

transportParityTest("parity: an untrusted caller is still Unauthenticated whatever identity headers it sends", {
    services: [reportingRoutes()],
    interceptors: edgeChain(true),
    scenario: async ({ transport }) => {
        try {
            await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
                headers: { "x-user-id": "erin", ...FORGED },
            });
            throw new Error("expected the untrusted caller to be rejected, but the call succeeded");
        } catch (err) {
            if (!(err instanceof ConnectError)) throw err;
            return { error: { code: err.code, message: err.rawMessage, details: [], metadata: {} } };
        }
    },
    compare: (http, local) => {
        for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
            assert.strictEqual(result.error?.code, Code.Unauthenticated, `${name} transport must reject an untrusted caller`);
        }
        defaultCompare(http, local);
    },
});

/**
 * Edge A -> service B over real sockets. A forwards every `x-auth-*` header it holds
 * (what a server `propagateHeaders` list does) plus the secret B trusts.
 */
nodeTest("parity: edge-to-service chain over sockets keeps the verified identity and drops a forged one", async () => {
    const seenAtB: Array<{ subject?: string | undefined; roles: readonly string[]; scopes: readonly string[]; name?: string | undefined }> = [];
    const serviceB = createServer({
        services: [
            defineService(AuthzService, {
                secureEcho: () => {
                    const auth = getAuthContext();
                    seenAtB.push({ subject: auth?.subject, roles: auth?.roles ?? [], scopes: auth?.scopes ?? [], name: auth?.name });
                    return create(EchoResponseSchema, { message: "b", subject: auth?.subject ?? "" });
                },
                publicEcho: () => create(EchoResponseSchema, { message: "b" }),
            }),
        ],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        interceptors: [
            createErrorHandlerInterceptor({ logErrors: false }),
            createGatewayAuthInterceptor({
                headerMapping: { subject: "x-auth-subject", roles: "x-auth-roles", scopes: "x-auth-scopes", name: "x-auth-name", claims: "x-auth-claims", type: "x-auth-type" },
                trustSource: { header: "x-gateway-secret", expectedValues: ["internal-secret"] },
            }),
        ],
        shutdown: { timeout: 1_000 },
    });
    await serviceB.start();
    const toB = createClient(AuthzService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${serviceB.address?.port}` }));

    const serviceA = createServer({
        services: [
            defineService(AuthzService, {
                secureEcho: async (_req, ctx) => {
                    const headers: Record<string, string> = { "x-gateway-secret": "internal-secret" };
                    for (const name of IDENTITY_HEADER_NAMES) {
                        const value = ctx.requestHeader.get(name);
                        if (value !== null) headers[name] = value;
                    }
                    return await toB.secureEcho(create(EchoRequestSchema, { message: "x" }), { headers });
                },
                publicEcho: () => create(EchoResponseSchema, { message: "a" }),
            }),
        ],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        interceptors: [...edgeChain(true)],
        shutdown: { timeout: 1_000 },
    });
    await serviceA.start();
    const toA = createClient(AuthzService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${serviceA.address?.port}` }));

    try {
        await toA.secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: parityHeaders({}) });
        await toA.secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: parityHeaders(FORGED) });
        await toA.secureEcho(create(EchoRequestSchema, { message: "x" }), { headers: parityHeaders({ "x-user-roles": '["reader"]' }) });
    } finally {
        await serviceA.stop();
        await serviceB.stop();
    }

    assert.deepStrictEqual(seenAtB, [
        { subject: "erin", roles: [], scopes: [], name: undefined },
        { subject: "erin", roles: [], scopes: [], name: undefined },
        { subject: "erin", roles: ["reader"], scopes: [], name: undefined },
    ]);
});
