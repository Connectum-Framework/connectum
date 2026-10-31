/**
 * Forged identity headers across a catalog call: client -> edge A -> service B.
 *
 * Edge A reads the user from `x-user-*` through the gateway interceptor with
 * `propagateHeaders: true` and forwards the verified identity to B with the server-level
 * `propagateHeaders` list on `ctx.call`. B trusts the `x-auth-*` names through a shared
 * secret that A adds in `outgoingInterceptors`. All three hops are real HTTP/2 sockets. A
 * user without roles must stay role-less at B whatever `x-auth-*` headers the client sent
 * to A, and the legitimate chain (user with roles) must keep delivering its identity.
 *
 * The services are described at runtime from a `FileDescriptorProto`, so no code generation
 * is needed.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, createFileRegistry, type DescMessage, type DescService, fromJson } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, defineCatalog, defineService, type Server, singleTransportResolver } from "@connectum/core";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

const registry = createFileRegistry(
    fromJson(FileDescriptorSetSchema, {
        file: [{
            name: "authtest/v1/forged.proto",
            package: "authtest.v1",
            syntax: "proto3",
            messageType: [{ name: "Msg", field: [{ name: "value", number: 1, type: "TYPE_STRING", label: "LABEL_OPTIONAL", jsonName: "value" }] }],
            service: [
                { name: "Target", method: [{ name: "Whoami", inputType: ".authtest.v1.Msg", outputType: ".authtest.v1.Msg" }] },
                { name: "Edge", method: [{ name: "Run", inputType: ".authtest.v1.Msg", outputType: ".authtest.v1.Msg" }] },
            ],
        }],
    }),
);

/** The descriptor, or a thrown error naming what is missing from the runtime registry. */
function mustGet<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`missing descriptor ${what}`);
    return value;
}

const Msg: DescMessage = mustGet(registry.getMessage("authtest.v1.Msg"), "Msg");
const Target: DescService = mustGet(registry.getService("authtest.v1.Target"), "Target");
const Edge: DescService = mustGet(registry.getService("authtest.v1.Edge"), "Edge");
const catalog = defineCatalog({ [Target.typeName]: Target, [Edge.typeName]: Edge });

/** Outgoing interceptor of edge A: adds the shared secret service B trusts. */
const addInternalSecret: Interceptor = (next) => async (req) => {
    req.header.set("x-gateway-secret", "internal-secret");
    return await next(req);
};

let serviceB: Server;
let edgeA: Server;
let edgeClient: { run(request: unknown, options?: { headers?: Record<string, string> }): Promise<{ value: string }> };

before(async () => {
    serviceB = createServer({
        services: [
            defineService(Target, {
                whoami: () => {
                    const auth = getAuthContext();
                    return { value: JSON.stringify(auth && { subject: auth.subject, roles: auth.roles, scopes: auth.scopes, name: auth.name, claims: auth.claims }) };
                },
            } as never),
        ],
        interceptors: [
            createGatewayAuthInterceptor({
                headerMapping: { subject: "x-auth-subject", roles: "x-auth-roles", scopes: "x-auth-scopes", name: "x-auth-name", claims: "x-auth-claims", type: "x-auth-type" },
                trustSource: { header: "x-gateway-secret", expectedValues: ["internal-secret"] },
            }),
        ],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        shutdown: { timeout: 200 },
    });
    await serviceB.start();

    edgeA = createServer({
        services: [
            defineService(Edge, {
                run: async (req: { value: string }, ctx: { call: (m: string, r: unknown) => Promise<{ value: string }> }) => await ctx.call("authtest.v1.Target/Whoami", req),
            } as never),
            // The catalog names Target, so a local stand-in keeps the server valid; calls go to B.
            defineService(Target, { whoami: () => ({ value: "local" }) } as never),
        ],
        catalog,
        enabledServices: [Edge.typeName],
        propagateHeaders: Object.values(AUTH_HEADERS),
        outgoingInterceptors: [addInternalSecret],
        remoteResolver: singleTransportResolver(createGrpcTransport({ baseUrl: `http://127.0.0.1:${serviceB.address?.port}` })),
        interceptors: [
            createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user-id", roles: "x-user-roles" },
                trustSource: { header: "x-edge-secret", expectedValues: ["edge-secret"] },
                propagateHeaders: true,
            }),
        ],
        port: 0,
        host: "127.0.0.1",
        allowHTTP1: false,
        shutdown: { timeout: 200 },
    });
    await edgeA.start();
    edgeClient = createClient(Edge, createGrpcTransport({ baseUrl: `http://127.0.0.1:${edgeA.address?.port}` })) as unknown as typeof edgeClient;
});

after(async () => {
    await edgeA.stop();
    await serviceB.stop();
});

const FORGED = { "x-auth-roles": '["admin"]', "x-auth-scopes": "admin:all", "x-auth-name": "Spoofed", "x-auth-claims": '{"suspended":false}' };

/** Calls edge A as the user `erin` with the given extra headers and returns the identity service B saw. */
async function seenAtB(headers: Record<string, string>): Promise<{ subject: string; roles: string[]; scopes: string[]; name?: string; claims: Record<string, unknown> }> {
    const res = await edgeClient.run(create(Msg, { value: "x" }), { headers: { "x-edge-secret": "edge-secret", "x-user-id": "erin", ...headers } });
    return JSON.parse(res.value);
}

describe("client -> edge A -> service B over catalog calls", () => {
    it("a user without roles stays without roles, scopes, name and claims at B", async () => {
        assert.deepStrictEqual(await seenAtB({}), { subject: "erin", roles: [], scopes: [], claims: {} });
    });

    it("forged x-auth-* headers sent to A do not change what B sees", async () => {
        assert.deepStrictEqual(await seenAtB(FORGED), { subject: "erin", roles: [], scopes: [], claims: {} });
    });

    it("a user with roles keeps exactly the roles A verified, forged scopes ignored", async () => {
        assert.deepStrictEqual(await seenAtB({ "x-user-roles": '["reader"]', ...FORGED }), { subject: "erin", roles: ["reader"], scopes: [], claims: {} });
    });
});
