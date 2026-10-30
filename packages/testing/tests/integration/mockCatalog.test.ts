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
import { createServer, defineCatalog, defineService } from "@connectum/core";
import { createMockContext } from "../../src/mockContext.ts";
import { type MockService, mockResolver, mockService } from "../../src/mockResolver.ts";
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

    // The mock context must not drift from production: the same call, made from a real
    // handler on a real server with `mockResolver`, ends the same way as made through the
    // mock context, for a success, a failure raised by the mock, and a service nobody mocks.
    describe("agrees with a real server using the same mocks", () => {
        type Outcome = { message: string } | { code: Code; error: string };
        const catalog = defineCatalog({ [EchoService.typeName]: EchoService });

        function outcomeOf(settle: () => Promise<{ message: string }>): Promise<Outcome> {
            return settle().catch((err: unknown) => {
                const connectErr = ConnectError.from(err);
                return { code: connectErr.code, error: connectErr.rawMessage };
            });
        }

        async function viaMockContext(mocks: MockService[]): Promise<Outcome> {
            const ctx = createMockContext({ catalog, mocks });
            return outcomeOf(async () => ({ message: (await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "hi" }))).message }));
        }

        async function viaRealServer(mocks: MockService[]): Promise<Outcome> {
            const server = createServer({
                services: [
                    defineService(StreamingService, {
                        echo: async (_req, ctx) => {
                            const res = await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "hi" }));
                            return create(ItemSchema, { value: res.message, sequence: 0 });
                        },
                        async *server() {},
                        client: async () => ({ total: 0 }),
                        async *bidi() {},
                    }),
                ],
                catalog,
                remoteResolver: mockResolver(mocks),
            });
            const client = server.client(StreamingService);
            return outcomeOf(async () => ({ message: (await client.echo(create(ItemSchema, { value: "go", sequence: 0 }))).value }));
        }

        const scenarios: { name: string; mocks: MockService[]; expected: Outcome }[] = [
            {
                name: "a successful mock",
                mocks: [mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: `mocked:${req.message}`, timestamp: 0n }) })],
                expected: { message: "mocked:hi" },
            },
            {
                name: "a mock that fails with a ConnectError",
                mocks: [
                    mockService(EchoService, {
                        echo: () => {
                            throw new ConnectError("no such record", Code.NotFound);
                        },
                    }),
                ],
                expected: { code: Code.NotFound, error: "no such record" },
            },
        ];
        for (const { name, mocks, expected } of scenarios) {
            it(`ends the same way for ${name}`, async () => {
                assert.deepStrictEqual(await viaMockContext(mocks), expected, "mock context");
                assert.deepStrictEqual(await viaRealServer(mocks), expected, "real server");
            });
        }

        it("ends the same way for a service that has no mock", async () => {
            const viaContext = await viaMockContext([]);
            const viaServer = await viaRealServer([]);
            assert.ok("code" in viaContext && viaContext.code === Code.Unavailable, `mock context must report Unavailable, got ${JSON.stringify(viaContext)}`);
            assert.deepStrictEqual(viaContext, viaServer, "the mock context must fail exactly like the real server");
        });
    });

    describe("an unusable catalog is rejected up front", () => {
        it("throws for a catalog with no service", () => {
            assert.throws(() => createMockContext({ catalog: defineCatalog({}), mocks: [] }), (err: unknown) => err instanceof Error && /at least one service/.test(err.message));
        });
    });

    // The inbound deadline cascades into outgoing calls: when the call does not set its own
    // `timeoutMs` the remaining inbound deadline is injected, and a caller may shorten the
    // deadline but never extend it (the effective value is `min(timeoutMs, remaining)`).
    describe("inbound deadline cascade", () => {
        async function deadlineSeenByMock(options: { inboundTimeoutMs?: number; callTimeoutMs?: number }): Promise<number | undefined> {
            let seen: number | undefined;
            const ctx = createMockContext({
                catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                mocks: [
                    mockService(EchoService, {
                        echo: (req, mockCtx) => {
                            seen = mockCtx.timeoutMs();
                            return create(EchoResponseSchema, { message: req.message, timestamp: 0n });
                        },
                    }),
                ],
                ...(options.inboundTimeoutMs !== undefined ? { timeoutMs: options.inboundTimeoutMs } : {}),
            });
            await ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" }), options.callTimeoutMs !== undefined ? { timeoutMs: options.callTimeoutMs } : undefined);
            return seen;
        }

        it("injects the remaining inbound deadline when the call sets none", async () => {
            const seen = await deadlineSeenByMock({ inboundTimeoutMs: 60_000 });
            assert.ok(seen !== undefined && seen > 0 && seen <= 60_000, `expected a deadline within (0, 60000], got ${seen}`);
            // A deadline that merely echoed some default would not track the inbound one.
            assert.ok(seen > 30_000, `the injected deadline must be what remains of the inbound one, got ${seen}`);
        });

        it("lets the call shorten the deadline", async () => {
            const seen = await deadlineSeenByMock({ inboundTimeoutMs: 60_000, callTimeoutMs: 1_000 });
            assert.ok(seen !== undefined && seen > 0 && seen <= 1_000, `expected a deadline within (0, 1000], got ${seen}`);
        });

        it("clamps a call's longer deadline to the remaining inbound one", async () => {
            const seen = await deadlineSeenByMock({ inboundTimeoutMs: 5_000, callTimeoutMs: 600_000 });
            assert.ok(seen !== undefined && seen > 0 && seen <= 5_000, `expected a deadline within (0, 5000], got ${seen}`);
        });

        it("sets no deadline when neither the inbound request nor the call has one", async () => {
            assert.strictEqual(await deadlineSeenByMock({}), undefined);
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

        // A bug in a test double (a typo that throws a TypeError) must be visible in the
        // test output: the mock runs in the test process, so nothing is hidden from a client.
        describe("an exception that is not a ConnectError", () => {
            const typo = new TypeError("Cannot read properties of undefined (reading 'boom')");

            function expectInternalWithCause(err: unknown, expected: unknown, message: string): true {
                const connectErr = ConnectError.from(err);
                assert.strictEqual(connectErr.code, Code.Internal);
                assert.strictEqual(connectErr.rawMessage, message, "the author's message must be kept");
                assert.strictEqual(connectErr.cause, expected, "the original error must be the cause");
                assert.strictEqual(connectErr.metadata.get("x-connectum-mock-error-id"), null, "the bookkeeping entry must not reach the caller");
                return true;
            }

            it("ctx.call rejects with Internal, the original message and the original error as cause", async () => {
                const ctx = createMockContext({
                    catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                    mocks: [
                        mockService(EchoService, {
                            echo: () => {
                                throw typo;
                            },
                        }),
                    ],
                });
                await assert.rejects(ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" })), (err: unknown) => expectInternalWithCause(err, typo, typo.message));
            });

            it("an async mock that rejects is reported the same way", async () => {
                const ctx = createMockContext({
                    catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                    mocks: [mockService(EchoService, { echo: async () => Promise.reject(typo) })],
                });
                await assert.rejects(ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" })), (err: unknown) => expectInternalWithCause(err, typo, typo.message));
            });

            it("a thrown value that is not an Error is reported by its text, with the value as cause", async () => {
                const ctx = createMockContext({
                    catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                    mocks: [
                        mockService(EchoService, {
                            echo: () => {
                                throw "plain string";
                            },
                        }),
                    ],
                });
                await assert.rejects(ctx.call("echo.v1.EchoService/Echo", create(EchoRequestSchema, { message: "x" })), (err: unknown) => expectInternalWithCause(err, "plain string", "plain string"));
            });

            it("ctx.stream delivers the items before the failure, then rejects with the original error as cause", async () => {
                const ctx = createMockContext({
                    catalog: defineCatalog({ [StreamingService.typeName]: StreamingService }),
                    mocks: [
                        mockService(StreamingService, {
                            async *server(req) {
                                yield create(ItemSchema, { value: `${req.value}-0`, sequence: 0 });
                                throw typo;
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
                    (err: unknown) => expectInternalWithCause(err, typo, typo.message),
                );
                assert.deepStrictEqual(received, ["s-0"]);
            });

            it("client-streaming and bidirectional mocks are reported the same way", async () => {
                const transport = mockResolver([
                    mockService(StreamingService, {
                        client: async () => {
                            throw typo;
                        },
                        async *bidi() {
                            throw typo;
                        },
                    }),
                ])({ typeName: StreamingService.typeName });
                assert.ok(transport);
                const client = createClient(StreamingService, transport);
                async function* oneItem() {
                    yield create(ItemSchema, { value: "a", sequence: 0 });
                }

                await assert.rejects(client.client(oneItem()), (err: unknown) => expectInternalWithCause(err, typo, typo.message));
                await assert.rejects(
                    (async () => {
                        for await (const _item of client.bidi(oneItem())) {
                            // the failure arrives before any item
                        }
                    })(),
                    (err: unknown) => expectInternalWithCause(err, typo, typo.message),
                );
            });

            it("each concurrent failure carries its own cause", async () => {
                const transport = mockResolver([
                    mockService(EchoService, {
                        echo: async (req) => {
                            await new Promise((resolve) => setTimeout(resolve, req.message === "slow" ? 20 : 0));
                            throw new Error(`failed:${req.message}`);
                        },
                    }),
                ])({ typeName: EchoService.typeName });
                assert.ok(transport);
                const client = createClient(EchoService, transport);

                const [slow, fast] = await Promise.all(
                    ["slow", "fast"].map((message) => client.echo(create(EchoRequestSchema, { message })).catch((err: unknown) => ConnectError.from(err))),
                );

                assert.strictEqual((slow as ConnectError).rawMessage, "failed:slow");
                assert.strictEqual(((slow as ConnectError).cause as Error).message, "failed:slow");
                assert.strictEqual((fast as ConnectError).rawMessage, "failed:fast");
                assert.strictEqual(((fast as ConnectError).cause as Error).message, "failed:fast");
            });

            it("a ConnectError thrown by the mock is passed on unchanged, metadata included", async () => {
                const transport = mockResolver([
                    mockService(EchoService, {
                        echo: () => {
                            throw new ConnectError("no such record", Code.NotFound, { "x-tag": "user-42" });
                        },
                    }),
                ])({ typeName: EchoService.typeName });
                assert.ok(transport);

                await assert.rejects(createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" })), (err: unknown) => {
                    const connectErr = ConnectError.from(err);
                    assert.strictEqual(connectErr.code, Code.NotFound);
                    assert.strictEqual(connectErr.rawMessage, "no such record");
                    assert.strictEqual(connectErr.metadata.get("x-tag"), "user-42");
                    assert.strictEqual(connectErr.cause, undefined);
                    return true;
                });
            });

            it("a method the mock does not implement still answers Unimplemented", async () => {
                const transport = mockResolver([mockService(EchoService, { echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }) })])({ typeName: EchoService.typeName });
                assert.ok(transport);

                await assert.rejects(createClient(EchoService, transport).secureEcho(create(EchoRequestSchema, { message: "x" })), (err: unknown) => ConnectError.from(err).code === Code.Unimplemented);
            });

            it("a mock keeps its own `this`", async () => {
                const impl = {
                    prefix: "kept:",
                    echo(req: { message: string }) {
                        return create(EchoResponseSchema, { message: `${this.prefix}${req.message}`, timestamp: 0n });
                    },
                };
                const transport = mockResolver([mockService(EchoService, impl)])({ typeName: EchoService.typeName });
                assert.ok(transport);

                assert.strictEqual((await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "x" }))).message, "kept:x");
            });
        });

        it("ctx.call rejects with Canceled when the call's signal is aborted before the mock answers", async () => {
            const ctx = createMockContext({
                catalog: defineCatalog({ [EchoService.typeName]: EchoService }),
                mocks: [
                    mockService(EchoService, {
                        echo: (_req, mockCtx) =>
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
