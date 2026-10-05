/**
 * Message bodies in the log, on real calls through `createServer`: by default
 * neither a unary nor a streamed call leaks its payload into the sink, and with
 * `includeBodies` the payload of both request and response is there.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createServer, defineService } from "@connectum/core";
import { ItemSchema, StreamingService } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import { createLoggerInterceptor } from "../../src/logger.ts";

const SECRET = "top-secret-value";

function routes() {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value }),
        async *server(req) {
            yield create(ItemSchema, { value: req.value });
        },
        client: () => ({ total: 0 }) as never,
        async *bidi(requests) {
            for await (const item of requests) yield item;
        },
    });
}

async function callBoth(options: { includeBodies?: boolean }): Promise<string> {
    const entries: unknown[] = [];
    const server = createServer({
        services: [routes()],
        interceptors: [createLoggerInterceptor({ ...options, logger: (message, ...args) => entries.push({ message, args }) })],
    });
    const client = server.localClient(StreamingService);
    await client.echo(create(ItemSchema, { value: SECRET }));
    for await (const _ of client.server(create(ItemSchema, { value: SECRET }))) {
        // drain
    }
    return JSON.stringify(entries);
}

describe("logger bodies on real calls", () => {
    it("keeps payloads of unary and streaming calls out of the log by default", async () => {
        for (const option of [{}, { includeBodies: false }]) {
            const log = await callBoth(option);
            assert.ok(log.includes("/streaming.v1.StreamingService/Echo"), "the calls are still logged");
            assert.ok(!log.includes(SECRET), `payload leaked into the log: ${log}`);
        }
    });

    it("puts the payload of unary and streaming calls into the log with includeBodies", async () => {
        const log = await callBoth({ includeBodies: true });
        assert.ok(log.split(SECRET).length - 1 >= 4, `request and response of both calls must carry the payload: ${log}`);
    });
});
