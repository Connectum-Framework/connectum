/**
 * Identity text and size limits when headers are propagated, on both transports.
 *
 * The shipped JWT interceptor propagates the identity of a signed token. Names, subjects and
 * scopes in Cyrillic, CJK or with an emoji must be admitted and reach the next hop unchanged
 * (the handler reads them back from the propagated headers). An identity that does not fit its
 * header (a subject over 512 characters, roles or claims over 8192) is refused as Unauthenticated,
 * never cut or left out; with propagation off the same token is admitted.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { createJwtAuthInterceptor, getAuthContext, parseAuthHeaders } from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

function routes() {
    return defineService(AuthzService, {
        secureEcho: (_req, ctx) => {
            const propagated = parseAuthHeaders(ctx.requestHeader);
            const own = getAuthContext();
            return create(EchoResponseSchema, {
                message: JSON.stringify({ propagated: propagated ? { subject: propagated.subject, name: propagated.name, scopes: propagated.scopes } : null, own: own ? { subject: own.subject, name: own.name } : null }),
            });
        },
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

function chain(propagateHeaders: boolean) {
    return [
        createErrorHandlerInterceptor({ logErrors: false }),
        createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, claimsMapping: { scopes: "perms", roles: "groups" }, propagateHeaders }),
    ];
}

async function call(transport: Parameters<typeof createClient>[1], claims: Record<string, unknown>): Promise<ParityScenarioResult> {
    try {
        const token = await createTestJwt({ sub: "alice", ...claims });
        const res = await createClient(AuthzService, transport).secureEcho(create(EchoRequestSchema, { message: "x" }), {
            headers: { authorization: `Bearer ${token}` },
        });
        return { response: JSON.parse(res.message) };
    } catch (err) {
        if (!(err instanceof ConnectError)) throw err;
        return { error: { code: err.code, message: err.rawMessage, details: [], metadata: {} } };
    }
}

function expectRefused(http: ParityScenarioResult, local: ParityScenarioResult): void {
    for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
        assert.ok(result.error, `${name} transport must refuse, got ${JSON.stringify(result.response)}`);
        assert.strictEqual(result.error.code, Code.Unauthenticated, `${name} transport must refuse with Unauthenticated`);
        assert.strictEqual(result.error.message, "Authentication failed");
    }
    defaultCompare(http, local);
}

for (const [label, name, subject, scope] of [
    ["Cyrillic", "Иван Петров", "Иван", "чтение"],
    ["CJK", "李雷", "李雷", "读取"],
    ["emoji", "Dev \u{1F600}", "user-\u{1F600}", "read-\u{1F600}"],
    ["Latin-1", "José Núñez", "José", "lectura"],
] as const) {
    transportParityTest(`parity: ${label} subject, name and scope reach the next hop unchanged on both transports`, {
        services: [routes()],
        interceptors: chain(true),
        scenario: async ({ transport }) => await call(transport, { sub: subject, name, perms: [scope] }),
        compare: (http, local) => {
            const expected = { propagated: { subject, name, scopes: [scope] }, own: { subject, name } };
            assert.deepStrictEqual(http.response, expected);
            assert.deepStrictEqual(local.response, expected);
            defaultCompare(http, local);
        },
    });
}

transportParityTest("parity: a subject of 512 characters is admitted and 513 is refused, on both transports", {
    services: [routes()],
    interceptors: chain(true),
    scenario: async ({ transport }) => {
        const at = await call(transport, { sub: "u".repeat(512) });
        const over = await call(transport, { sub: `${"u".repeat(512)}-A` });
        return { response: { atLimit: (at.response as { propagated: { subject: string } }).propagated.subject.length, over: over.error?.code } };
    },
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { atLimit: 512, over: Code.Unauthenticated });
        assert.deepStrictEqual(local.response, { atLimit: 512, over: Code.Unauthenticated });
        defaultCompare(http, local);
    },
});

for (const [label, claims] of [
    ["roles over 8192 characters", { groups: Array.from({ length: 1000 }, (_, i) => `role-${i}-xxxxxxxx`) }],
    ["scopes over 8192 characters", { perms: Array.from({ length: 1000 }, (_, i) => `scope:${i}:xxxxxxxx`) }],
    ["claims over 8192 characters", { blob: "x".repeat(9000) }],
    ["a name over 256 characters", { name: "n".repeat(257) }],
] as const) {
    transportParityTest(`parity: ${label} are refused as Unauthenticated when propagated, on both transports`, {
        services: [routes()],
        interceptors: chain(true),
        scenario: async ({ transport }) => await call(transport, claims),
        compare: expectRefused,
    });

    transportParityTest(`parity: ${label} are admitted when propagation is off, on both transports`, {
        services: [routes()],
        interceptors: chain(false),
        scenario: async ({ transport }) => await call(transport, claims),
        compare: (http, local) => {
            for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
                assert.ok(result.response, `${name} transport must admit, got ${JSON.stringify(result.error)}`);
                assert.strictEqual((result.response as { propagated: unknown }).propagated, null);
            }
            defaultCompare(http, local);
        },
    });
}
