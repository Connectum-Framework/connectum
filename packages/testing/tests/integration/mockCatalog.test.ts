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
import { Code, ConnectError, createClient } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import * as core from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defineCatalog } from "@connectum/core";
import { createMockContext } from "../../src/mockContext.ts";
import { mockResolver, mockService } from "../../src/mockResolver.ts";
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

        // The header name and the value "true" are the documented contract
        // (service-communication/resolvers guide and the service-catalog spec),
        // so they are spelled out as literals here instead of being read back
        // from the exported constant: renaming the constant or the value in
        // the source must break this test.
        let tag: string | null = null;
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" }), {
            onHeader: (header) => {
                tag = header.get("x-connectum-mock");
            },
        });
        assert.strictEqual(res.message, "mock:x");
        assert.strictEqual(tag, "true");
    });

    it("returns null for a service it does not mock", () => {
        assert.strictEqual(mockResolver([]) ({ typeName: EchoService.typeName }), null);
    });

    it("returns a transport only for the services it mocks, among several", () => {
        const resolver = mockResolver([
            mockService(StreamingService, {
                echo: (req) => create(ItemSchema, { value: req.value, sequence: 0 }),
            }),
        ]);
        assert.ok(resolver({ typeName: StreamingService.typeName }), "the mocked service must resolve to a transport");
        assert.strictEqual(resolver({ typeName: EchoService.typeName }), null, "a service outside the mock set must resolve to null");
    });

    it("throws an Error naming the service on duplicate mocked service typeNames", () => {
        const dup = mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }) });
        assert.throws(
            () => mockResolver([dup, dup]),
            (err: unknown) => err instanceof Error && err.message.includes(EchoService.typeName),
        );
    });

    it("accepts several mocks of different services without treating them as duplicates", () => {
        const echoMock = mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }) });
        const streamingMock = mockService(StreamingService, { echo: (req) => create(ItemSchema, { value: req.value, sequence: 0 }) });
        assert.doesNotThrow(() => mockResolver([echoMock, streamingMock]));
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

    // Header propagation is opt-in: an inbound header reaches an outgoing call
    // only when its exact name is in the allow-list, and the allow-list is empty
    // by default.
    describe("header propagation is an opt-in allow-list", () => {
        async function seenHeaders(options: { propagateHeaders?: readonly string[]; callHeaders?: HeadersInit }): Promise<{ tenant: string | null; other: string | null }> {
            let seen = { tenant: null as string | null, other: null as string | null };
            const ctx = createMockContext({
                catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                mocks: [
                    mockService(EchoService, {
                        echo: (req, mockCtx) => {
                            seen = { tenant: mockCtx.requestHeader.get("x-tenant"), other: mockCtx.requestHeader.get("x-other") };
                            return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
                        },
                    }),
                ],
                requestHeader: { "x-tenant": "acme", "x-other": "not-allowed" },
                ...(options.propagateHeaders ? { propagateHeaders: options.propagateHeaders } : {}),
            });
            await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }), options.callHeaders ? { headers: options.callHeaders } : undefined);
            return seen;
        }

        it("propagates nothing when no allow-list is configured", async () => {
            const seen = await seenHeaders({});
            assert.deepStrictEqual(seen, { tenant: null, other: null });
        });

        it("does not propagate a header that is not in the allow-list", async () => {
            const seen = await seenHeaders({ propagateHeaders: ["x-tenant"] });
            assert.deepStrictEqual(seen, { tenant: "acme", other: null });
        });

        it("lets headers passed in the call options win over propagated ones", async () => {
            const seen = await seenHeaders({ propagateHeaders: ["x-tenant"], callHeaders: { "x-tenant": "override" } });
            assert.strictEqual(seen.tenant, "override");
        });
    });

    // A catalog service that has no mock is a resolver miss, which the
    // catalog contract reports as Code.Unavailable naming the service.
    describe("calls to a service outside the mock set", () => {
        const catalog = defineCatalog({ [EchoService.typeName]: EchoService, [StreamingService.typeName]: StreamingService });

        it("ctx.call rejects with Unavailable naming the service", async () => {
            const ctx = createMockContext({
                catalog,
                mocks: [mockService(StreamingService, { echo: (req) => create(ItemSchema, { value: req.value, sequence: 0 }) })],
            });
            await assert.rejects(ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" })), (err: unknown) => {
                const connectErr = ConnectError.from(err);
                assert.strictEqual(connectErr.code, Code.Unavailable);
                assert.ok(connectErr.message.includes(EchoService.typeName), `message must name the service, got: ${connectErr.message}`);
                return true;
            });
        });

        it("ctx.stream rejects with Unavailable naming the service", async () => {
            const ctx = createMockContext({
                catalog,
                mocks: [mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }) })],
            });
            await assert.rejects(
                (async () => {
                    for await (const _ of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 0 }))) {
                        // no item expected
                    }
                })(),
                (err: unknown) => {
                    const connectErr = ConnectError.from(err);
                    assert.strictEqual(connectErr.code, Code.Unavailable);
                    assert.ok(connectErr.message.includes(StreamingService.typeName), `message must name the service, got: ${connectErr.message}`);
                    return true;
                },
            );
        });
    });

    // Error semantics match production: a ConnectError thrown by the mock reaches
    // the caller with its code and message intact, for unary and for a stream
    // that fails after delivering part of its output.
    describe("error semantics", () => {
        it("ctx.call surfaces the code and message of a ConnectError thrown by the mock", async () => {
            const ctx = createMockContext({
                catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                mocks: [
                    mockService(EchoService, {
                        echo: () => {
                            throw new ConnectError("no such record", Code.NotFound);
                        },
                    }),
                ],
            });
            await assert.rejects(ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" })), (err: unknown) => {
                const connectErr = ConnectError.from(err);
                assert.strictEqual(connectErr.code, Code.NotFound);
                assert.strictEqual(connectErr.rawMessage, "no such record");
                return true;
            });
        });

        it("ctx.stream delivers the items before a mid-stream failure, then rejects with the mock's code", async () => {
            const ctx = createMockContext({
                catalog: defineCatalog({ [StreamingService.typeName]: StreamingService }),
                mocks: [
                    mockService(StreamingService, {
                        async *server(req) {
                            yield create(ItemSchema, { value: `${req.value}-0`, sequence: 0 });
                            throw new ConnectError("quota exhausted", Code.ResourceExhausted);
                        },
                    }),
                ],
            });
            const received: string[] = [];
            await assert.rejects(
                (async () => {
                    for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 0 }))) {
                        received.push(item.value);
                    }
                })(),
                (err: unknown) => {
                    const connectErr = ConnectError.from(err);
                    assert.strictEqual(connectErr.code, Code.ResourceExhausted);
                    assert.strictEqual(connectErr.rawMessage, "quota exhausted");
                    return true;
                },
            );
            assert.deepStrictEqual(received, ["s-0"]);
        });

        it("ctx.call rejects with Canceled when the call's signal is aborted before the mock answers", async () => {
            const ctx = createMockContext({
                catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                mocks: [
                    mockService(EchoService, {
                        echo: (req, mockCtx) =>
                            new Promise((_resolve, reject) => {
                                mockCtx.signal.addEventListener("abort", () => reject(mockCtx.signal.reason), { once: true });
                            }),
                    }),
                ],
            });
            const controller = new AbortController();
            const pending = ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }), { signal: controller.signal });
            controller.abort();
            await assert.rejects(pending, (err: unknown) => ConnectError.from(err).code === Code.Canceled);
        });
    });
});
