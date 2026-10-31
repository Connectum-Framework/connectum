/**
 * A handler that changes its identity does not change the cached one, on both transports.
 *
 * With the `cache` option the verified identity is stored and handed to every later request
 * with the same credential. If that object were the one a handler receives, a handler (or a
 * library it calls) that pushes a role into `getAuthContext().roles` would grant that role to
 * every later request presenting the same token. The first request tries to mutate the
 * identity in every way a handler can reach it; the second request, with the same token, must
 * see exactly what the verifier returned, while the mutating request still works on its own copy, as it does without a cache. The shipped generic and session interceptors are
 * used, with a verifier that counts calls so a cache that stopped working cannot hide the
 * result.
 */

import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "@connectum/testing/parity";
import { type AuthContext, createAuthInterceptor, createSessionAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { AuthzService, EchoRequestSchema, EchoResponseSchema } from "../fixtures/authz/pb/authz/v1/authz_pb.ts";

/** A fresh identity per verification, as a real verifier returns one. */
function identity(): AuthContext {
    return { subject: "alice", roles: ["user"], scopes: ["read"], claims: { tenant: "acme", nested: { flags: ["a"] } }, type: "test" };
}

/** What the handler sees, as JSON; on "mutate" it first tries to change every part it can reach. */
function routes() {
    return defineService(AuthzService, {
        secureEcho: (req) => {
            const auth = getAuthContext();
            if (!auth) throw new Error("no identity");
            const blocked: string[] = [];
            if (req.message === "mutate") {
                const attempts: Array<[string, () => void]> = [
                    ["roles", () => (auth.roles as string[]).push("admin")],
                    ["scopes", () => (auth.scopes as string[]).push("admin:all")],
                    ["claims", () => ((auth.claims as Record<string, unknown>).tenant = "victim")],
                    ["nested claims", () => (((auth.claims as Record<string, unknown>).nested as { flags: string[] }).flags.push("x"))],
                    ["subject", () => ((auth as { subject: string }).subject = "root")],
                ];
                for (const [part, attempt] of attempts) {
                    try {
                        attempt();
                    } catch {
                        blocked.push(part);
                    }
                }
            }
            return create(EchoResponseSchema, {
                message: JSON.stringify({ subject: auth.subject, roles: auth.roles, scopes: auth.scopes, claims: auth.claims, blocked }),
            });
        },
        publicEcho: () => create(EchoResponseSchema, { message: "public" }),
    });
}

/** Mutating call, then a read-only call with the same token; also reports how often the verifier ran. */
async function twoCalls(transport: Parameters<typeof createClient>[1], verifications: Map<string, number>): Promise<ParityScenarioResult> {
    const token = randomUUID();
    const client = createClient(AuthzService, transport);
    const headers = { authorization: `Bearer ${token}` };
    const first = JSON.parse((await client.secureEcho(create(EchoRequestSchema, { message: "mutate" }), { headers })).message);
    const second = JSON.parse((await client.secureEcho(create(EchoRequestSchema, { message: "read" }), { headers })).message);
    return { response: { first, second, verifications: verifications.get(token) } };
}

/** Oracle: the verifier ran once, the mutating call worked on its own copy, the later call saw the original. */
function expectUntouched(http: ParityScenarioResult, local: ParityScenarioResult): void {
    const untouched = { subject: "alice", roles: ["user"], scopes: ["read"], claims: { tenant: "acme", nested: { flags: ["a"] } } };
    for (const [name, result] of [["HTTP", http], ["local", local]] as const) {
        const response = result.response as { first: Record<string, unknown>; second: Record<string, unknown>; verifications: number };
        assert.strictEqual(response.verifications, 1, `${name}: the second request must be served from the cache`);
        assert.deepStrictEqual({ ...response.second, blocked: undefined }, { ...untouched, blocked: undefined }, `${name}: a later request must see what the verifier returned`);
        assert.deepStrictEqual(response.first.blocked, [], `${name}: the mutating request keeps working on its own copy`);
        assert.deepStrictEqual(response.first.roles, ["user", "admin"], `${name}: the mutating request sees its own change`);
    }
    defaultCompare(http, local);
}

const genericVerifications = new Map<string, number>();
transportParityTest("parity: a handler does not change the identity cached by createAuthInterceptor, on both transports", {
    services: [routes()],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createAuthInterceptor({
            verifyCredentials: async (token) => {
                genericVerifications.set(token, (genericVerifications.get(token) ?? 0) + 1);
                return identity();
            },
            cache: { ttl: 60_000 },
        }),
    ],
    scenario: async ({ transport }) => await twoCalls(transport, genericVerifications),
    compare: expectUntouched,
});

const sessionVerifications = new Map<string, number>();
transportParityTest("parity: a handler does not change the identity cached by createSessionAuthInterceptor, on both transports", {
    services: [routes()],
    interceptors: [
        createErrorHandlerInterceptor({ logErrors: false }),
        createSessionAuthInterceptor({
            verifySession: async (token) => {
                sessionVerifications.set(token, (sessionVerifications.get(token) ?? 0) + 1);
                return {};
            },
            mapSession: async () => identity(),
            cache: { ttl: 60_000 },
        }),
    ],
    scenario: async ({ transport }) => await twoCalls(transport, sessionVerifications),
    compare: expectUntouched,
});
