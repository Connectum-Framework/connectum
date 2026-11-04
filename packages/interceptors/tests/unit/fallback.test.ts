/**
 * Fallback interceptor tests
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { create, isMessage } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockRequest as createBaseRequest, createMockNext, createMockNextError } from "@connectum/test-fixtures";
import { ItemSchema } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createFallbackInterceptor } from "../../src/fallback.ts";

/** A request the way a server or client chain builds it: the method knows its output message type. */
function createMockRequest(options?: Parameters<typeof createBaseRequest>[0]) {
    const request = createBaseRequest(options);
    request.method.output = ItemSchema;
    return request;
}

/** The text of a response message after checking it is a real message of the output type, not a bare object. */
function valueOf(message: unknown): string {
    assert.ok(isMessage(message, ItemSchema), "the response must be a message of the output type");
    return message.value;
}

describe("fallback interceptor", () => {
    it("should pass request on success without asking the fallback handler", async () => {
        const fallbackHandler = mock.fn(() => ({ value: "value" }));
        const interceptor = createFallbackInterceptor({
            handler: fallbackHandler,
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, "success");
        assert.strictEqual(fallbackHandler.mock.calls.length, 0);
    });

    // A fallback value stands in for a failed dependency, never for a refusal of access.
    for (const code of [Code.Unauthenticated, Code.PermissionDenied]) {
        it(`should rethrow a ${Code[code]} failure as it is and not ask the fallback handler`, async () => {
            const fallbackHandler = mock.fn(() => ({ value: "value" }));
            const interceptor = createFallbackInterceptor({ handler: fallbackHandler });
            const refusal = new ConnectError("refused", code);
            const handler = interceptor((async () => {
                throw refusal;
            }) as any);

            await assert.rejects(
                () => handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } })),
                (err: unknown) => err === refusal,
            );
            assert.strictEqual(fallbackHandler.mock.calls.length, 0);
        });
    }

    for (const code of [Code.Canceled, Code.Unknown, Code.InvalidArgument, Code.DeadlineExceeded, Code.NotFound, Code.Internal, Code.Unavailable]) {
        it(`should still ask the fallback handler for a ${Code[code]} failure`, async () => {
            const fallbackHandler = mock.fn(() => ({ value: "value" }));
            const interceptor = createFallbackInterceptor({ handler: fallbackHandler });
            const handler = interceptor(createMockNextError(code, "failed") as any);

            const result = await handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));

            assert.strictEqual(fallbackHandler.mock.calls.length, 1);
            assert.strictEqual(valueOf(result.message), "value");
        });
    }

    it("should still ask the fallback handler for an error that is not a ConnectError", async () => {
        const fallbackHandler = mock.fn(() => ({ value: "value" }));
        const interceptor = createFallbackInterceptor({ handler: fallbackHandler });
        const handler = interceptor((async () => {
            throw new Error("plain failure");
        }) as any);

        const result = await handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));

        assert.strictEqual(fallbackHandler.mock.calls.length, 1);
        assert.strictEqual(valueOf(result.message), "value");
    });

    it("should call handler on failure", async () => {
        let handlerCalled = false;
        const interceptor = createFallbackInterceptor({
            handler: () => {
                handlerCalled = true;
                return { value: "value" };
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        await handler(mockReq);

        assert.strictEqual(handlerCalled, true);
    });

    it("should return fallback value from handler", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => ({ value: "cached_data" }),
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(valueOf(result.message), "cached_data");
    });

    it("should propagate error if handler throws", async () => {
        const interceptor = createFallbackInterceptor({
            handler: () => {
                throw new Error("Fallback also failed");
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof Error);
                assert.strictEqual(err.message, "Fallback also failed");
                return true;
            },
        );
    });

    it("should skip streaming when skipStreaming=true", async () => {
        const fallbackHandler = mock.fn(() => ({ value: "value" }));
        const interceptor = createFallbackInterceptor({
            handler: fallbackHandler,
            skipStreaming: true,
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true });

        // A failing streaming call: with the fallback applied it would turn into a substitute response.
        // Skipped, the failure reaches the caller untouched and the fallback handler is never asked.
        const failure = new ConnectError("Service error", Code.Internal);
        const next = mock.fn(async () => {
            throw failure;
        });

        const handler = interceptor(next as any);
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => err === failure,
        );
        assert.strictEqual(fallbackHandler.mock.calls.length, 0);
    });

    it("should handle async handler", async () => {
        const interceptor = createFallbackInterceptor({
            handler: async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                return { value: "async_value" };
            },
        });

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = createMockNextError(Code.Internal, "Service error");

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(valueOf(result.message), "async_value");
    });

    // skipStreaming is not given: a failing streaming call is left alone by default.
    it("should skip streaming by default", async () => {
        const fallbackHandler = mock.fn(() => ({ value: "value" }));
        const interceptor = createFallbackInterceptor({ handler: fallbackHandler });
        const failure = new ConnectError("Service error", Code.Internal);
        const next = mock.fn(async () => {
            throw failure;
        });

        await assert.rejects(
            () => interceptor(next as any)(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true })),
            (err: unknown) => err === failure,
        );
        assert.strictEqual(fallbackHandler.mock.calls.length, 0);
    });

    // With skipStreaming: false a failing streaming call gets a streaming response whose only message is the substitute.
    it("should replace a failing streaming call when skipStreaming=false, with a streaming response of one message", async () => {
        const interceptor = createFallbackInterceptor({ handler: () => ({ value: "value" }), skipStreaming: false });
        const next = createMockNextError(Code.Internal, "Service error");

        const result = await interceptor(next as any)(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" }, stream: true }));

        assert.strictEqual(result.stream, true);
        const messages: unknown[] = [];
        for await (const message of result.message as AsyncIterable<unknown>) {
            messages.push(message);
        }
        assert.deepStrictEqual(messages.map(valueOf), ["value"]);
    });

    it("should preserve original error context", async () => {
        let capturedError: Error | null = null;
        const interceptor = createFallbackInterceptor({
            handler: (error) => {
                capturedError = error;
                return { value: "value" };
            },
        });

        const originalError = new ConnectError("Original service error", Code.Internal);

        const mockReq = createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } });

        const next = mock.fn(async () => {
            throw originalError;
        });

        const handler = interceptor(next as any);
        await handler(mockReq);

        assert.strictEqual(capturedError, originalError);
        assert(capturedError !== null);
        assert((capturedError as unknown as object) instanceof Error);
        assert.strictEqual((capturedError as ConnectError).code, Code.Internal);
    });

    // The handler is required and must be a function (FallbackOptions.handler); anything else is refused
    // when the interceptor is created, not on the first failure.
    for (const [label, value] of [
        ["a string", "not a function"],
        ["undefined", undefined],
        ["null", null],
        ["an object", { value: "value" }],
        ["a number", 42],
    ] as const) {
        it(`should reject ${label} as the handler with a TypeError`, () => {
            assert.throws(
                () =>
                    createFallbackInterceptor({
                        handler: value as unknown as () => unknown,
                    }),
                (err: unknown) => err instanceof TypeError && err.message === "createFallbackInterceptor: handler must be a function",
            );
        });
    }

    // The value of the handler becomes the response message of the call, so it must be one. A
    // plain object is turned into the method's output message; a message passes as it is; any
    // other value would fail much later in the protocol layer with a serialization text that says
    // nothing about the handler, so it is refused here and the error names the handler.
    describe("what the handler may return", () => {
        const failing = () => createMockNextError(Code.Internal, "Service error") as any;

        it("turns a plain object into a message of the output type", async () => {
            const result = await createFallbackInterceptor({ handler: () => ({ value: "plain", sequence: 7 }) })(failing())(createMockRequest());

            assert.ok(isMessage(result.message, ItemSchema));
            assert.deepStrictEqual({ value: result.message.value, sequence: result.message.sequence }, { value: "plain", sequence: 7 });
        });

        it("uses a message of the output type as it is", async () => {
            const message = create(ItemSchema, { value: "made" });
            const result = await createFallbackInterceptor({ handler: () => message })(failing())(createMockRequest());

            assert.strictEqual(result.message, message);
        });

        it("turns the plain object into a message for a streaming call as well", async () => {
            const result = await createFallbackInterceptor({ handler: () => ({ value: "plain" }), skipStreaming: false })(failing())(createMockRequest({ stream: true }));

            const messages: unknown[] = [];
            for await (const message of result.message as AsyncIterable<unknown>) messages.push(message);
            assert.deepStrictEqual(messages.map(valueOf), ["plain"]);
        });

        it("accepts an object without fields as the empty message", async () => {
            const result = await createFallbackInterceptor({ handler: () => ({}) })(failing())(createMockRequest());

            assert.strictEqual(valueOf(result.message), "");
        });

        for (const [label, produce] of [
            ["undefined", () => undefined],
            ["null", () => null],
            ["a string", () => "text"],
            ["a number", () => 5],
            ["an array", () => []],
            ["a class instance", () => new (class Holder {
                value = "x";
            })()],
        ] as const) {
            it(`refuses ${label}, naming the handler and the expected type`, async () => {
                const interceptor = createFallbackInterceptor({ handler: produce as () => unknown });

                await assert.rejects(
                    () => interceptor(failing())(createMockRequest()),
                    (err: unknown) => {
                        assert.ok(err instanceof TypeError);
                        assert.match(err.message, /^createFallbackInterceptor: handler must return a streaming\.v1\.Item message or a plain object/);
                        return true;
                    },
                );
            });
        }

        it("refuses an object with a field the output type does not have, naming the field", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ items: [] }) });

            await assert.rejects(
                () => interceptor(failing())(createMockRequest()),
                (err: unknown) => err instanceof TypeError && /items is not a field of streaming\.v1\.Item/.test(err.message),
            );
        });

        it("refuses a message of another type", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => create(ItemSchema, { value: "x" }) });
            const request = createMockRequest();
            request.method.output = { ...ItemSchema, typeName: "other.v1.Other" };

            await assert.rejects(
                () => interceptor(failing())(request),
                (err: unknown) => err instanceof TypeError && /handler must return a other\.v1\.Other message/.test(err.message),
            );
        });

        it("refuses a number the encoder cannot write (a fraction in an int32) and keeps the cause", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ sequence: 1.5 }) });

            await assert.rejects(
                () => interceptor(failing())(createMockRequest()),
                (err: unknown) => err instanceof TypeError && /cannot be converted/.test(err.message) && err.cause instanceof Error,
            );
        });
    });

    describe("fallback response properties", () => {
        it("should return response with correct service, method, and stream: false", async () => {
            const interceptor = createFallbackInterceptor({
                handler: () => ({ value: "data" }),
            });

            const mockReq = createMockRequest({
                service: "my.package.MyService",
                method: "GetItems",
                message: { id: 1 },
            });

            const next = createMockNextError(Code.Internal, "Service error");

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual(result.stream, false, "fallback response should have stream: false");
            assert.strictEqual(
                result.service.typeName,
                "my.package.MyService",
                "fallback response should preserve service",
            );
            assert.strictEqual(result.method.name, "GetItems", "fallback response should preserve method");
            assert.strictEqual(valueOf(result.message), "data");
        });

        // The headers of a request include credentials, identity written by authentication
        // interceptors and hop-by-hop fields. None of them belongs in a synthesised response; the
        // content type is the one protocol field the response needs.
        it("should answer with the content-type header alone, whatever the request carried", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
            const headers = new Headers({
                authorization: "Bearer token-1",
                cookie: "sid=abc",
                traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
                "x-auth-subject": "alice",
                "x-auth-roles": '["admin"]',
                "x-auth-scopes": "read",
                "x-auth-claims": '{"tenant":"t1"}',
                "x-auth-name": "Alice",
                "x-auth-type": "jwt",
                "x-forwarded-for": "10.0.0.5",
                "transfer-encoding": "chunked",
                te: "trailers",
                "content-type": "application/json",
            });
            const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(createMockRequest({ headers }));

            assert.deepStrictEqual([...result.header.entries()], [["content-type", "application/json"]]);
            assert.deepStrictEqual([...result.trailer.entries()], []);
        });

        it("should answer with an empty header when the request names no content type", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
            const headers = new Headers({ authorization: "Bearer token-1", "x-auth-subject": "alice" });
            const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(createMockRequest({ headers }));

            assert.deepStrictEqual([...result.header.entries()], []);
            assert.deepStrictEqual([...result.trailer.entries()], []);
        });

        // gRPC and gRPC-web clients read the call status from the trailer; without grpc-status they
        // report "missing status". Connect puts the status in the body, so its trailer stays empty.
        for (const [contentType, expectedTrailer] of [
            ["application/grpc", [["grpc-status", "0"]]],
            ["application/grpc+proto", [["grpc-status", "0"]]],
            ["application/grpc-web+proto", [["grpc-status", "0"]]],
            ["application/grpc-web-text", [["grpc-status", "0"]]],
            ["Application/Grpc+Proto", [["grpc-status", "0"]]],
            ["APPLICATION/GRPC-WEB+JSON", [["grpc-status", "0"]]],
            ["application/proto", []],
            ["application/json", []],
            ["application/connect+proto", []],
        ] as const) {
            it(`should give the trailer ${JSON.stringify(expectedTrailer)} for the request content type ${contentType}`, async () => {
                const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
                const headers = new Headers({ "content-type": contentType });
                const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(createMockRequest({ headers }));

                assert.deepStrictEqual([...result.trailer.entries()], expectedTrailer);
                assert.deepStrictEqual([...result.header.entries()], [["content-type", contentType]]);
            });
        }

        it("should not hand back the request header object, nor follow later changes to the request", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
            const request = createMockRequest({ headers: new Headers({ "content-type": "application/proto" }) });
            const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(request);

            assert.notStrictEqual(result.header, request.header);
            request.header.set("x-auth-subject", "added-after");
            request.header.set("content-type", "application/json");
            assert.deepStrictEqual([...result.header.entries()], [["content-type", "application/proto"]]);
            result.header.set("x-from-response", "1");
            assert.strictEqual(request.header.get("x-from-response"), null, "changing the response header must not change the request");
        });

        // A Connect GET request carries its message in the URL and sends no content-type; the
        // `encoding` query parameter names the type the response must have.
        for (const [encoding, expected] of [
            ["json", "application/json"],
            ["proto", "application/proto"],
        ] as const) {
            it(`should derive ${expected} for a Connect GET request with encoding=${encoding} and no content-type`, async () => {
                const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
                const request = createMockRequest({
                    url: `http://localhost/test.TestService/TestMethod?connect=v1&encoding=${encoding}&message=e30`,
                    headers: new Headers({ authorization: "Bearer token-1" }),
                });
                request.requestMethod = "GET";
                const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(request);

                assert.deepStrictEqual([...result.header.entries()], [["content-type", expected]]);
                assert.deepStrictEqual([...result.trailer.entries()], []);
            });
        }

        // A type that cannot be derived stays absent: the client then reports an unsupported
        // content type, an explicit failure, rather than receiving a guessed one.
        for (const [label, url] of [
            ["an unknown encoding", "http://localhost/test.TestService/TestMethod?encoding=xml"],
            ["an encoding named like an Object.prototype member", "http://localhost/test.TestService/TestMethod?encoding=toString"],
            ["no encoding", "http://localhost/test.TestService/TestMethod?connect=v1"],
        ] as const) {
            it(`should leave the header empty for a Connect GET request with ${label}`, async () => {
                const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
                const request = createMockRequest({ url });
                request.requestMethod = "GET";
                const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(request);

                assert.deepStrictEqual([...result.header.entries()], []);
            });
        }

        it("should prefer the request content-type over the encoding parameter of a GET request", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
            const request = createMockRequest({
                url: "http://localhost/test.TestService/TestMethod?encoding=json",
                headers: new Headers({ "content-type": "application/proto" }),
            });
            request.requestMethod = "GET";
            const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(request);

            assert.deepStrictEqual([...result.header.entries()], [["content-type", "application/proto"]]);
        });

        it("should ignore the encoding parameter of a request that is not a GET", async () => {
            const interceptor = createFallbackInterceptor({ handler: () => ({ value: "data" }) });
            const request = createMockRequest({ url: "http://localhost/test.TestService/TestMethod?encoding=json" });
            request.requestMethod = "POST";
            const result = await interceptor(createMockNextError(Code.Internal, "Service error") as any)(request);

            assert.deepStrictEqual([...result.header.entries()], []);
        });

        // A rejecting asynchronous handler fails the call with its own rejection:
        // the awaited handler result is what the caller sees, not the original error.
        it("should fail with the rejection of an asynchronous handler, not the original error", async () => {
            const interceptor = createFallbackInterceptor({
                handler: async () => {
                    throw new Error("Async fallback failed");
                },
            });
            const next = createMockNextError(Code.Internal, "Service error");

            await assert.rejects(
                () =>
                    interceptor(next as any)(
                        createMockRequest({
                            service: "test.Service",
                            method: "Method",
                            message: { field: "value" },
                        }),
                    ),
                (err: unknown) => {
                    assert.ok(err instanceof Error);
                    assert.strictEqual(err.message, "Async fallback failed");
                    return true;
                },
            );
        });
    });
});
