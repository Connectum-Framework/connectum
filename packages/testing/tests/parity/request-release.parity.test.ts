/**
 * Cancelling a client-streaming call whose handler waits for requests.
 *
 * The caller's request stream stays open and empty, so the handler is parked in
 * `for await (const message of requests)`. When the caller cancels, both
 * transports must release it: the loop over the requests ends and the handler's
 * `finally` runs. In-process used to leave the handler suspended.
 */

import assert from "node:assert";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { defaultCompare, transportParityTest } from "../../src/transportParityTest.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const seen = { phase: "not started", requestLoop: "running" as "running" | "ended" | "threw", finished: Promise.withResolvers<void>() };

const routes = defineService(StreamingService, {
    echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
    async *server() {},
    async client(requests) {
        seen.phase = "waiting for requests";
        try {
            for await (const _item of requests) {
                // the caller never sends anything
            }
            seen.requestLoop = "ended";
            return create(CountSchema, { total: 0 });
        } catch (error) {
            seen.requestLoop = "threw";
            throw error;
        } finally {
            seen.phase = "finished";
            seen.finished.resolve();
        }
    },
    async *bidi() {},
});

transportParityTest("parity: cancelling a client stream whose handler waits for requests releases the handler", {
    services: [routes],
    scenario: async ({ transport }) => {
        seen.phase = "not started";
        seen.requestLoop = "running";
        seen.finished = Promise.withResolvers<void>();
        const abort = new AbortController();
        // Open and empty: the caller has neither sent nor closed anything.
        const requests = (async function* () {
            await new Promise<void>(() => {});
        })();
        const call = createClient(StreamingService, transport)
            .client(requests, { signal: abort.signal })
            .then(
                () => -1,
                (err: unknown) => (err instanceof ConnectError ? err.code : -2),
            );
        // Wait until the handler is parked on the request stream; how long that takes depends on the machine.
        for (let waited = 0; seen.phase !== "waiting for requests" && waited < 2_000; waited += 10) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        const phaseBeforeAbort = seen.phase;
        abort.abort();
        const code = await call;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
        });
        const released = await Promise.race([seen.finished.promise.then(() => true), timeout]);
        clearTimeout(timer);
        return { response: { phaseBeforeAbort, released, requestLoop: seen.requestLoop }, error: { code, message: "<canceled>" } };
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.deepStrictEqual(result.response, { phaseBeforeAbort: "waiting for requests", released: true, requestLoop: "ended" }, `${name} transport must release the waiting handler`);
            assert.strictEqual(result.error?.code, Code.Canceled, `${name} transport must report the cancelled call as canceled`);
        }
        defaultCompare(http, local);
    },
});
