/**
 * Unit tests for the logger interceptor's isolation from its own sink and from
 * message serialization.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockRequest } from "@connectum/test-fixtures";
import { ItemSchema } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";

async function* two<T>(a: T, b: T): AsyncGenerator<T> {
    yield a;
    yield b;
}

describe("logger interceptor isolation", () => {
    it("reports a throwing sink once on the console and keeps serving calls", async () => {
        const consoleError = mock.method(console, "error", () => {});
        try {
            const interceptor = createLoggerInterceptor({
                logger: () => {
                    throw new Error("sink down");
                },
            });
            const response = { stream: false, message: { result: "success" }, method: { output: {} } };
            const handler = interceptor((async () => response) as never);

            for (let i = 0; i < 3; i++) {
                const result = await handler(createMockRequest({ service: "test.Service", method: "Method", message: { field: "value" } }));
                assert.strictEqual(result, response, "the response object must pass through untouched");
            }

            assert.strictEqual(consoleError.mock.calls.length, 1, "a sink that fails on every line is reported once, not once per line");
            assert.match(String(consoleError.mock.calls[0]?.arguments[0]), /logger/i);
        } finally {
            consoleError.mock.restore();
        }
    });

    it("rethrows the original error of a failed call even when the sink throws", async () => {
        const consoleError = mock.method(console, "error", () => {});
        try {
            const interceptor = createLoggerInterceptor({
                logger: () => {
                    throw new Error("sink down");
                },
            });
            const original = new ConnectError("denied", Code.PermissionDenied);
            const handler = interceptor((async () => {
                throw original;
            }) as never);

            await assert.rejects(
                () => handler(createMockRequest({ service: "test.Service", method: "Method", message: {} })),
                (err: unknown) => err === original,
            );
        } finally {
            consoleError.mock.restore();
        }
    });

    it("logs the Connect code of a failed call and the code Unknown for a plain error", async () => {
        const lines: string[] = [];
        const interceptor = createLoggerInterceptor({ logger: (message) => lines.push(message) });

        const connectFailure = interceptor((async () => {
            throw new ConnectError("quota", Code.ResourceExhausted);
        }) as never);
        await assert.rejects(() => connectFailure(createMockRequest({ service: "test.Service", method: "Method", message: {} })));
        assert.ok(
            lines.some((line) => line === "RPC /test.Service/Method failed with ResourceExhausted"),
            JSON.stringify(lines),
        );

        lines.length = 0;
        const plainFailure = interceptor((async () => {
            throw new Error("boom");
        }) as never);
        await assert.rejects(() => plainFailure(createMockRequest({ service: "test.Service", method: "Method", message: {} })));
        assert.ok(
            lines.some((line) => line === "RPC /test.Service/Method failed with Unknown"),
            JSON.stringify(lines),
        );
    });

    it("keeps streaming a response when a message cannot be converted to JSON", async () => {
        const lines: string[] = [];
        const interceptor = createLoggerInterceptor({ logger: (message) => lines.push(message) });
        // An empty object is not a message schema: converting with it throws.
        const response = { stream: true, message: two({ result: "1" }, { result: "2" }), method: { output: {} } };
        const handler = interceptor((async () => response) as never);

        const result = await handler(createMockRequest({ service: "test.Service", method: "Method", stream: true, message: two({}, {}) }));
        const received: unknown[] = [];
        for await (const item of result.message as AsyncIterable<unknown>) received.push(item);

        assert.deepStrictEqual(received, [{ result: "1" }, { result: "2" }]);
        assert.strictEqual(lines.filter((line) => line === "STREAM /test.Service/Method response").length, 2, "every message is still logged");
    });

    it("logs a stream that fails midway with its Connect code and rethrows the error to the reader", async () => {
        const lines: string[] = [];
        const interceptor = createLoggerInterceptor({ logger: (message) => lines.push(message) });
        const original = new ConnectError("gone", Code.Unavailable);
        async function* failing(): AsyncGenerator<unknown> {
            yield create(ItemSchema, { value: "1" });
            throw original;
        }
        const response = { stream: true, message: failing(), method: { output: ItemSchema } };
        const handler = interceptor((async () => response) as never);

        const result = await handler(createMockRequest({ service: "test.Service", method: "Method", stream: true, message: two({}, {}) }));
        await assert.rejects(
            async () => {
                for await (const _ of result.message as AsyncIterable<unknown>) {
                    // drain
                }
            },
            (err: unknown) => err === original,
        );
        assert.ok(lines.includes("RPC /test.Service/Method failed with Unavailable"), JSON.stringify(lines));
        assert.ok(lines.at(-1)?.startsWith("RPC /test.Service/Method completed in "), "completion line comes last");
    });
});

describe("logger interceptor on an abandoned response stream", () => {
    it("closes the call out in the log when the reader stops before the end", async () => {
        const lines: string[] = [];
        const interceptor = createLoggerInterceptor({ logger: (message) => lines.push(message) });
        const response = { stream: true, message: two(create(ItemSchema, { value: "1" }), create(ItemSchema, { value: "2" })), method: { output: ItemSchema } };
        const handler = interceptor((async () => response) as never);

        const result = await handler(createMockRequest({ service: "test.Service", method: "Method", stream: true, message: two({}, {}) }));
        for await (const _ of result.message as AsyncIterable<unknown>) {
            break;
        }

        assert.strictEqual(lines.filter((line) => line === "STREAM /test.Service/Method response").length, 1);
        assert.ok(lines.at(-1)?.startsWith("RPC /test.Service/Method completed in "), JSON.stringify(lines));
        assert.strictEqual(lines.filter((line) => line.includes("completed in")).length, 1, "the completion line is written once");
    });
});
