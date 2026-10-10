/**
 * Streaming handlers see the verified identity identically over HTTP/2 and
 * over the in-process transport.
 *
 * The handlers put the identity they observe at each point of their life into
 * the messages they send back, so the comparison between the two transports is
 * a comparison of what the handler really saw: before the first suspension,
 * after an await, after a yield, and in `finally` (reported through a second
 * call, since a finished stream cannot carry it).
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { transportParityTest } from "@connectum/testing/parity";
import { createAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const authenticate = () =>
    createAuthInterceptor({
        verifyCredentials: (token) => ({ subject: token, roles: [], scopes: [], claims: {}, type: "parity" }),
    });

function routes() {
    const finallySeen: Array<{ run: string; what: string }> = [];
    const who = () => getAuthContext()?.subject ?? "anonymous";
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: finallySeen.filter((entry) => entry.run === req.value).map((entry) => entry.what).join(",") }),
        client: async () => create(CountSchema, { total: 0 }),
        async *server(_req, ctx) {
            const run = ctx.requestHeader.get("x-run") ?? "";
            try {
                yield create(ItemSchema, { value: `start:${who()}`, sequence: 0 });
                await new Promise((resolve) => setImmediate(resolve));
                yield create(ItemSchema, { value: `after-await:${who()}`, sequence: 1 });
                yield create(ItemSchema, { value: `after-yield:${who()}`, sequence: 2 });
            } finally {
                finallySeen.push({ run, what: `server-finally:${who()}` });
            }
        },
        async *bidi(requests, ctx) {
            const run = ctx.requestHeader.get("x-run") ?? "";
            try {
                let i = 0;
                for await (const _item of requests) {
                    await new Promise((resolve) => setImmediate(resolve));
                    yield create(ItemSchema, { value: `bidi-${i}:${who()}`, sequence: i });
                    i++;
                }
            } finally {
                finallySeen.push({ run, what: `bidi-finally:${who()}` });
            }
        },
    });
}

transportParityTest("parity: server and bidi handlers observe the verified identity at every phase identically", {
    services: [routes()],
    interceptors: [authenticate()],
    scenario: async ({ transport, transportKind }) => {
        const client = createClient(StreamingService, transport);
        const headers = { authorization: "Bearer alice", "x-run": transportKind };

        const server: string[] = [];
        for await (const item of client.server(create(ItemSchema, { value: "go" }), { headers })) {
            server.push(item.value);
        }
        async function* inputs() {
            for (let i = 0; i < 3; i++) {
                yield create(ItemSchema, { value: `in-${i}`, sequence: i });
            }
        }
        const bidi: string[] = [];
        for await (const item of client.bidi(inputs(), { headers })) {
            bidi.push(item.value);
        }
        const cleanups = (await client.echo(create(ItemSchema, { value: transportKind }), { headers })).value;
        return { response: { server, bidi, cleanups } };
    },
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, local.response);
        assert.deepStrictEqual(local.response, {
            server: ["start:alice", "after-await:alice", "after-yield:alice"],
            bidi: ["bidi-0:alice", "bidi-1:alice", "bidi-2:alice"],
            cleanups: "server-finally:alice,bidi-finally:alice",
        });
    },
});
