/**
 * Resource authorization over a real HTTP/2 connection and in process, with the shipped
 * authentication and authorization interceptors in front of runtime-built services.
 *
 * The resource rules are real `connectum.auth.v1.resources` options. The client sees the same
 * outcome on both transports: the handler runs only for an allowed object, an engine outage keeps
 * its code, any other authorizer failure is `Internal` without its text, and a refused caller who
 * may not see the object gets `NotFound`.
 */

import assert from "node:assert";
import { create, type DescMethod, type DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createErrorHandlerInterceptor } from "@connectum/interceptors";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defaultCompare, transportParityTest } from "@connectum/testing/parity";
import { createAuthInterceptor, createProtoAuthzInterceptor } from "../../src/index.ts";
import type { AuthContext, ResourceCheck } from "../../src/types.ts";
import { buildResourceService } from "../helpers/resource-test-helpers.ts";

const { service, methods } = buildResourceService({
    Read: { input: "DocRequest", auth: { resources: [{ action: "read", idField: "id", type: "doc" }] } },
    Update: { input: "DocRequest", auth: { resources: [{ action: "update", idField: "id", type: "doc" }] } },
    Watch: { input: "DocRequest", kind: "server", auth: { resources: [{ action: "read", idField: "id", type: "doc" }] } },
});

const routes = defineService(service as never, {
    read: (request: { id: string }) => ({ id: `read ${request.id}` }),
    update: (request: { id: string }) => ({ id: `update ${request.id}` }),
    watch: async function* (request: { id: string }) {
        yield { id: `watch ${request.id}` };
    },
} as never);

/** The engine: `allowed` is allowed everything, `viewer` may only read, `down` and `boom` fail. */
const engine = {
    check: ({ action, resource }: ResourceCheck) => {
        if (resource.id === "boom") throw new Error("engine password=hunter2");
        if (resource.id === "down") throw new ConnectError("engine unreachable", Code.Unavailable);
        if (resource.id === "allowed") return "allow" as const;
        if (resource.id === "viewer" && action === "read") return "allow" as const;
        return "deny" as const;
    },
};

const authenticate = createAuthInterceptor({
    verifyCredentials: async (): Promise<AuthContext> => ({ subject: "alice", roles: [], scopes: [], claims: {}, type: "test" }),
});
const errorHandler = createErrorHandlerInterceptor({ logErrors: false });
const headers = { authorization: "Bearer any" };

type Reply = { id: string };

async function outcome(transport: Transport, method: DescMethod, id: string): Promise<{ response: Reply[] } | { error: { code: number; message: string } }> {
    const client = createClient(service as DescService as never, transport) as unknown as Record<string, (request: object, options: object) => unknown>;
    const request = create(method.input, { id });
    try {
        const call = client[method.localName] as (request: object, options: object) => unknown;
        if (method.methodKind === "server_streaming") {
            const replies: Reply[] = [];
            for await (const reply of call(request, { headers }) as AsyncIterable<Reply>) replies.push({ id: reply.id });
            return { response: replies };
        }
        const reply = (await call(request, { headers })) as Reply;
        return { response: [{ id: reply.id }] };
    } catch (error) {
        const failure = ConnectError.from(error);
        return { error: { code: failure.code, message: failure.rawMessage } };
    }
}

const read = methods.Read as DescMethod;
const update = methods.Update as DescMethod;
const watch = methods.Watch as DescMethod;

function scenario(config: { hide?: boolean }, method: DescMethod, id: string, expected: { response: Reply[] } | { error: { code: number; message: string } }) {
    const label = "error" in expected ? `code ${Code[expected.error.code]}` : "the handler runs";
    transportParityTest(`parity: ${method.name} "${id}"${config.hide ? " with hideExistence" : ""} -> ${label}`, {
        services: [routes],
        interceptors: [
            errorHandler,
            authenticate,
            createProtoAuthzInterceptor({
                defaultPolicy: "deny",
                resourceAuthorizer: engine,
                ...(config.hide && { hideExistence: { action: "read" } }),
                logger: { warn: () => undefined, error: () => undefined },
            }),
        ],
        scenario: async ({ transport }) => ({ ...(await outcome(transport, method, id)) }),
        compare: (http, local) => {
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                const seen = "error" in result ? { error: result.error } : { response: result.response };
                assert.deepStrictEqual(seen, expected, name);
            }
            defaultCompare(http, local);
        },
    });
}

scenario({}, read, "allowed", { response: [{ id: "read allowed" }] });
scenario({}, update, "stranger", { error: { code: Code.PermissionDenied, message: "Access denied" } });
scenario({}, update, "down", { error: { code: Code.Unavailable, message: "engine unreachable" } });
scenario({}, update, "boom", { error: { code: Code.Internal, message: "Internal error" } });
scenario({}, read, "", { error: { code: Code.InvalidArgument, message: 'Invalid request: "id" must be a non-empty string' } });
scenario({ hide: true }, update, "stranger", { error: { code: Code.NotFound, message: "Not found" } });
scenario({ hide: true }, update, "viewer", { error: { code: Code.PermissionDenied, message: "Access denied" } });
scenario({}, watch, "allowed", { response: [{ id: "watch allowed" }] });
scenario({}, watch, "stranger", { error: { code: Code.PermissionDenied, message: "Access denied" } });
