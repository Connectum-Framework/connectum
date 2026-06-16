/**
 * Service-catalog testing helpers — mockResolver + createMockContext.
 *
 * Covers section 8: mock-tagged responses, resolver miss → null, and a
 * createMockContext that drives the production catalog dispatch path
 * (ctx.call / ctx.stream + header propagation) against canned mocks.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import * as core from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defineCatalog } from "@connectum/core";
import { createMockContext } from "../../src/mockContext.ts";
import { MOCK_RESPONSE_HEADER, mockResolver, mockService } from "../../src/mockResolver.ts";
import { type EchoRequest, EchoRequestSchema, type EchoResponse, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "echo.v1.EchoService/Echo": { request: EchoRequest; response: EchoResponse };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
    }
}

describe("mockResolver", () => {
    it("serves a mock and tags every response with x-connectum-mock", async () => {
        const resolver = mockResolver([mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: `mock:${req.message}`, timestamp: 0n }) })]);
        const transport = resolver({ typeName: EchoService.typeName });
        assert.ok(transport, "resolver must return a transport for the mocked service");

        let tag: string | null = null;
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" }), {
            onHeader: (header) => {
                tag = header.get(MOCK_RESPONSE_HEADER);
            },
        });
        assert.strictEqual(res.message, "mock:x");
        assert.strictEqual(tag, "true");
    });

    it("returns null for a service it does not mock", () => {
        assert.strictEqual(mockResolver([]) ({ typeName: EchoService.typeName }), null);
    });

    it("throws on duplicate mocked service typeNames", () => {
        const dup = mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }) });
        assert.throws(() => mockResolver([dup, dup]), /duplicate mock service "echo\.v1\.EchoService"/);
    });

    it("is NOT exported from @connectum/core", () => {
        assert.strictEqual("mockResolver" in core, false, "mockResolver belongs to @connectum/testing only");
    });
});

describe("createMockContext", () => {
    it("drives ctx.call against the mocks", async () => {
        const ctx = createMockContext({
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            mocks: [mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: `mocked:${req.message}`, timestamp: 0n }) })],
        });
        const result = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "hi" }));
        assert.strictEqual(result.message, "mocked:hi");
    });

    it("drives ctx.stream against the mocks", async () => {
        const ctx = createMockContext({
            catalog: defineCatalog({ [StreamingService.typeName]: StreamingService }),
            mocks: [
                mockService(StreamingService, {
                    async *server(req) {
                        for (let i = 0; i < 2; i++) yield create(ItemSchema, { value: `${req.value}-${i}`, sequence: i });
                    },
                }),
            ],
        });
        const out: string[] = [];
        for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 0 }))) {
            out.push(item.value);
        }
        assert.deepStrictEqual(out, ["s-0", "s-1"]);
    });

    it("propagates allow-listed inbound headers into the mock call", async () => {
        let seen: string | null = null;
        const ctx = createMockContext({
            catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
            mocks: [
                mockService(EchoService, {
                    echo: (req, mockCtx) => {
                        seen = mockCtx.requestHeader.get("x-tenant");
                        return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
                    },
                }),
            ],
            requestHeader: { "x-tenant": "acme" },
            propagateHeaders: ["x-tenant"],
        });
        await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }));
        assert.strictEqual(seen, "acme", "propagated header must reach the mock handler");
    });
});
