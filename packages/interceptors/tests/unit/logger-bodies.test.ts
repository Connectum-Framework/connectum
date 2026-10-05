/**
 * Request and response bodies reach the log sink only when `includeBodies` is
 * set. Bodies carry credentials, tokens and personal data, so the default log
 * line carries metadata (path, event, duration, failure code) and nothing else.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createMockRequest } from "@connectum/test-fixtures";
import { ItemSchema } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";

const SECRET = "secret-password-123";

interface Entry {
    message: string;
    args: unknown[];
}

function collect(): { entries: Entry[]; logger: (message: string, ...args: unknown[]) => void } {
    const entries: Entry[] = [];
    return { entries, logger: (message, ...args) => entries.push({ message, args }) };
}

async function* messages<T>(...items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _ of stream) {
        // drain
    }
}

describe("logger bodies: unary", () => {
    const request = () => createMockRequest({ service: "test.Service", method: "Method", message: { password: SECRET } });
    const next = (async () => ({ stream: false, message: { token: SECRET }, method: { output: ItemSchema } })) as never;

    it("writes request and response lines without any payload by default", async () => {
        const sink = collect();
        await createLoggerInterceptor({ logger: sink.logger })(next)(request());

        assert.deepStrictEqual(
            sink.entries.map((e) => e.message.replace(/completed in .*/, "completed in <ms>")),
            ["RPC /test.Service/Method request", "RPC /test.Service/Method response", "RPC /test.Service/Method completed in <ms>"],
        );
        for (const entry of sink.entries) {
            assert.deepStrictEqual(entry.args, [], `line "${entry.message}" must carry no arguments`);
        }
        assert.ok(!JSON.stringify(sink.entries).includes(SECRET));
    });

    it("passes request and response bodies to the sink when includeBodies is set", async () => {
        const sink = collect();
        await createLoggerInterceptor({ includeBodies: true, logger: sink.logger })(next)(request());

        assert.deepStrictEqual(sink.entries[0]?.args, [{ password: SECRET }]);
        assert.deepStrictEqual(sink.entries[1]?.args, [{ token: SECRET }]);
        assert.deepStrictEqual(sink.entries[2]?.args, []);
    });
});

describe("logger bodies: streaming", () => {
    const streamRequest = () => createMockRequest({ service: "test.Service", method: "Method", stream: true, message: messages({ password: SECRET }) });
    const streamNext = (() =>
        Promise.resolve({ stream: true, message: messages(create(ItemSchema, { value: SECRET })), method: { output: ItemSchema } })) as never;

    it("writes stream lines without any payload by default", async () => {
        const sink = collect();
        const result = await createLoggerInterceptor({ logger: sink.logger })(streamNext)(streamRequest());
        await drain(result.message as AsyncIterable<unknown>);

        assert.ok(sink.entries.some((e) => e.message === "STREAM /test.Service/Method response"));
        for (const entry of sink.entries) {
            assert.deepStrictEqual(entry.args, [], `line "${entry.message}" must carry no arguments`);
        }
        assert.ok(!JSON.stringify(sink.entries).includes(SECRET));
    });

    it("does not convert response messages to JSON when bodies are off", async () => {
        const sink = collect();
        const brokenSchemaNext = (() => Promise.resolve({ stream: true, message: messages({ value: "x" }), method: { output: {} } })) as never;
        const result = await createLoggerInterceptor({ logger: sink.logger })(brokenSchemaNext)(streamRequest());
        await drain(result.message as AsyncIterable<unknown>);

        assert.ok(!JSON.stringify(sink.entries).includes("could not be converted"), "the conversion must not even be attempted");
    });

    it("passes the JSON form of each streamed message to the sink when includeBodies is set", async () => {
        const sink = collect();
        const result = await createLoggerInterceptor({ includeBodies: true, logger: sink.logger })(streamNext)(streamRequest());
        await drain(result.message as AsyncIterable<unknown>);

        const responses = sink.entries.filter((e) => e.message === "STREAM /test.Service/Method response");
        assert.strictEqual(responses.length, 1);
        assert.deepStrictEqual(responses[0]?.args, [{ value: SECRET }]);
    });
});
