/**
 * The header allow-list is read once, when the server is created.
 *
 * `authorization` is left out of `defaultPropagateHeaders` on purpose:
 * forwarding credentials is an explicit choice. A list that kept changing
 * after `createServer()` (because the server held the caller's array, or
 * because the shared default could be extended) would let unrelated code turn
 * that forwarding on.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { defineService } from "../../src/defineService.ts";
import { defaultPropagateHeaders } from "../../src/propagateHeaders.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

declare module "../../src/serviceCatalog.ts" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
    }
}

/** `secureEcho` calls the local `echo`, which answers with the `authorization` header it received. */
function startServer(propagateHeaders: string[]) {
    return createServer({
        catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
        propagateHeaders,
        services: [
            defineService(EchoService, {
                echo: (_req, ctx) => create(EchoResponseSchema, { message: String(ctx.requestHeader.get("authorization")), timestamp: 0n }),
                secureEcho: async (_req, ctx) => {
                    const inner = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }));
                    return create(EchoResponseSchema, { message: inner.message, timestamp: 0n });
                },
                rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
            }),
        ],
    });
}

async function authorizationSeenByCallee(server: ReturnType<typeof startServer>): Promise<string> {
    const response = await server.localClient(EchoService).secureEcho(create(EchoRequestSchema, { message: "go" }), { headers: { authorization: "Bearer secret", "x-request-id": "r1" } });
    return response.message;
}

describe("propagateHeaders is read once", () => {
    it("is not changed by a later push into the array passed to createServer()", async () => {
        const headers = ["x-request-id"];
        const server = startServer(headers);
        assert.strictEqual(await authorizationSeenByCallee(server), "null", "before the mutation authorization is not forwarded");

        headers.push("authorization");
        assert.strictEqual(await authorizationSeenByCallee(server), "null", "a later push must not turn credential forwarding on");
    });

    it("keeps forwarding the names it was created with after the caller's array is emptied", async () => {
        const headers = ["authorization"];
        const server = startServer(headers);
        headers.length = 0;
        assert.strictEqual(await authorizationSeenByCallee(server), "Bearer secret");
    });

    it("freezes defaultPropagateHeaders and keeps it spreadable", () => {
        assert.ok(Object.isFrozen(defaultPropagateHeaders));
        assert.deepStrictEqual([...defaultPropagateHeaders, "x-tenant-id"], ["traceparent", "tracestate", "x-tenant-id"]);
        assert.throws(() => (defaultPropagateHeaders as string[]).push("authorization"), TypeError);
        assert.deepStrictEqual([...defaultPropagateHeaders], ["traceparent", "tracestate"]);
    });
});
