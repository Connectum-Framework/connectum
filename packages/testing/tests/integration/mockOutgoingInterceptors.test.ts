/**
 * `createMockContext({ outgoingInterceptors })` — the chain runs on mock routes
 * exactly as production catalog dispatch runs it on resolver routes: once per
 * call for every RPC kind, outside the mock transport's own middleware, so the
 * mock response marker is still present.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { defineCatalog } from "@connectum/core";
import { createMockContext } from "../../src/mockContext.ts";
import { MOCK_RESPONSE_HEADER, mockService } from "../../src/mockResolver.ts";
import { type Count, CountSchema, type Item, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

declare module "@connectum/core" {
    interface ConnectumCallMap {
        "streaming.v1.StreamingService/Echo": { request: Item; response: Item };
    }
    interface ConnectumStreamMap {
        "streaming.v1.StreamingService/Server": { request: Item; response: Item; kind: "server-stream" };
        "streaming.v1.StreamingService/Client": { request: Item; response: Count; kind: "client-stream" };
        "streaming.v1.StreamingService/Bidi": { request: Item; response: Item; kind: "bidi" };
    }
}

const SEEN = "x-outgoing-seen";

function makeContext(interceptor: Interceptor) {
    return createMockContext({
        catalog: defineCatalog({ [StreamingService.typeName]: StreamingService }),
        outgoingInterceptors: [interceptor],
        mocks: [
            mockService(StreamingService, {
                echo: (req, ctx) => create(ItemSchema, { value: `${req.value}|${ctx.requestHeader.get(SEEN) ?? "none"}`, sequence: 0 }),
                async *server(req, ctx) {
                    const seen = ctx.requestHeader.get(SEEN) ?? "none";
                    for (let i = 0; i < req.sequence; i++) yield create(ItemSchema, { value: `${req.value}-${i}|${seen}`, sequence: i });
                },
                async client(requests, ctx) {
                    let total = 0;
                    for await (const _item of requests) total += 1;
                    return create(CountSchema, { total: total + (ctx.requestHeader.get(SEEN) === "yes" ? 100 : 0) });
                },
                async *bidi(requests, ctx) {
                    const seen = ctx.requestHeader.get(SEEN) ?? "none";
                    for await (const item of requests) yield create(ItemSchema, { value: `${item.value}|${seen}`, sequence: item.sequence });
                },
            }),
        ],
    });
}

describe("createMockContext — outgoingInterceptors on mock routes", () => {
    it("runs the chain once per call for every RPC kind and keeps the mock response marker", async () => {
        let calls = 0;
        let marker: string | null = null;
        const spy: Interceptor = (next) => async (req) => {
            calls += 1;
            req.header.set(SEEN, "yes");
            const res = await next(req);
            marker = res.header.get(MOCK_RESPONSE_HEADER);
            return res;
        };
        const ctx = makeContext(spy);

        assert.strictEqual((await ctx.call("streaming.v1.StreamingService/Echo", create(ItemSchema, { value: "u", sequence: 0 }))).value, "u|yes");
        assert.strictEqual(marker, "true", "the mock transport's own marker interceptor still runs, inside the chain");

        const served: string[] = [];
        for await (const item of ctx.stream("streaming.v1.StreamingService/Server")(create(ItemSchema, { value: "s", sequence: 2 }))) served.push(item.value);
        assert.deepStrictEqual(served, ["s-0|yes", "s-1|yes"]);

        const handle = ctx.stream("streaming.v1.StreamingService/Client")();
        handle.send(create(ItemSchema, { value: "c", sequence: 0 }));
        assert.strictEqual((await handle.close()).total, 101);

        const bidi = ctx.stream("streaming.v1.StreamingService/Bidi")();
        bidi.send(create(ItemSchema, { value: "b", sequence: 0 }));
        bidi.close();
        const echoed: string[] = [];
        for await (const item of bidi.responses) echoed.push(item.value);
        assert.deepStrictEqual(echoed, ["b|yes"]);

        assert.strictEqual(calls, 4, "one chain invocation per call");
    });
});
