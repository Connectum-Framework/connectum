/**
 * Cancelling a streaming call finishes the handler's output iterator on both
 * transports.
 *
 * A generator suspended at `yield` only unwinds when something pulls it again.
 * Over HTTP/2 the server pumps it into the socket, but whether a cancelled
 * call is noticed there depends on the runtime (observed: Node 26.10 and Bun
 * kept the handler parked); in-process nothing pumps once the client stops
 * reading. In both cases the handler's `signal` aborts while its `finally`
 * (open cursors, subscriptions, handles) would never run. These tests observe
 * the handler side of every cancellation path on both transports. Leaving a
 * `for await` loop with `break` is not a cancellation on either transport and
 * must not abort the handler's signal.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

type Kind = "http" | "local";
type Method = "server" | "bidi";

/** What the handler observed about its own cancellation. */
interface Probe {
    finallyRuns: () => number;
    signalAborted: () => boolean;
    finallyRan: Promise<void>;
}

type Pace = "yield-only" | "slow-await";

/**
 * A stream that yields until cancelled. `yield-only` parks at `yield` between
 * pulls; `slow-await` spends 150 ms in an await that ignores the signal before
 * each yield, so a cancellation can arrive while its `next()` is in flight.
 */
function makeRoutes(pace: Pace): { routes: ReturnType<typeof defineService>; probe: Probe } {
    let runs = 0;
    let aborted = false;
    let resolveFinally: () => void = () => {};
    const finallyRan = new Promise<void>((resolve) => {
        resolveFinally = resolve;
    });

    async function* items(value: string, signal: AbortSignal) {
        signal.addEventListener(
            "abort",
            () => {
                aborted = true;
            },
            { once: true },
        );
        try {
            for (let i = 0; ; i++) {
                if (pace === "slow-await") {
                    await sleep(150);
                }
                yield create(ItemSchema, { value: `${value}:${i}`, sequence: i });
            }
        } finally {
            runs++;
            resolveFinally();
        }
    }

    const routes = defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        server: (req, ctx) => items(req.value, ctx.signal),
        client: async () => create(CountSchema, { total: 0 }),
        bidi: (_requests, ctx) => items("bidi", ctx.signal),
    });
    return { routes, probe: { finallyRuns: () => runs, signalAborted: () => aborted, finallyRan } };
}

/** True when `promise` settles within `ms`; used only to assert that something did not happen. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const timer = new AbortController();
    const outcome = await Promise.race([promise.then(() => true), sleep(ms, false, { signal: timer.signal })]);
    timer.abort();
    return outcome;
}

const started: Array<ReturnType<typeof createServer>> = [];

/** A failing assertion must not leave a listening server holding the process open. */
afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

async function start(kind: Kind, pace: Pace) {
    const { routes, probe } = makeRoutes(pace);
    const server = createServer({ services: [routes], port: 0, allowHTTP1: false, shutdown: { timeout: 1_000 } });
    started.push(server);
    await server.start();
    const client =
        kind === "http"
            ? createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${server.address?.port}` }))
            : server.localClient(StreamingService);
    return { server, client, probe };
}

function open(client: Awaited<ReturnType<typeof start>>["client"], method: Method, signal: AbortSignal) {
    const first = create(ItemSchema, { value: method, sequence: 0 });
    if (method === "server") {
        return client.server(first, { signal });
    }
    return client.bidi(
        (async function* () {
            yield first;
        })(),
        { signal },
    );
}

for (const kind of ["http", "local"] as const) {
    for (const method of ["server", "bidi"] as const) {
        describe(`${method} stream cancellation over ${kind}`, () => {
            it("aborting the call's signal inside the loop runs the handler's finally", async () => {
                const { server, client, probe } = await start(kind, "yield-only");
                const abort = new AbortController();
                let seen = 0;
                let failure: ConnectError | undefined;
                try {
                    for await (const _item of open(client, method, abort.signal)) {
                        if (++seen === 2) {
                            abort.abort();
                        }
                    }
                } catch (error) {
                    failure = ConnectError.from(error);
                }
                assert.ok(failure, "the client iteration must end with an error");
                assert.ok(await settlesWithin(probe.finallyRan, 2_000), "the handler's finally must run");
                assert.strictEqual(probe.signalAborted(), true);
                assert.strictEqual(probe.finallyRuns(), 1);
                await server.stop();
            });

            it("break followed by abort runs the handler's finally", async () => {
                const { server, client, probe } = await start(kind, "yield-only");
                const abort = new AbortController();
                let seen = 0;
                for await (const _item of open(client, method, abort.signal)) {
                    if (++seen === 2) {
                        break;
                    }
                }
                abort.abort();
                assert.ok(await settlesWithin(probe.finallyRan, 2_000), "the handler's finally must run");
                assert.strictEqual(probe.signalAborted(), true);
                await server.stop();
            });

            it("break followed by server.stop() runs the handler's finally", async () => {
                const { server, client, probe } = await start(kind, "yield-only");
                let seen = 0;
                for await (const _item of open(client, method, new AbortController().signal)) {
                    if (++seen === 2) {
                        break;
                    }
                }
                await server.stop();
                assert.ok(await settlesWithin(probe.finallyRan, 2_000), "the handler's finally must run");
                assert.strictEqual(probe.signalAborted(), true);
            });

            it("an abort that arrives while the handler is inside an await finishes it exactly once", async () => {
                const { server, client, probe } = await start(kind, "slow-await");
                const abort = new AbortController();
                let seen = 0;
                try {
                    for await (const _item of open(client, method, abort.signal)) {
                        if (++seen === 1) {
                            setTimeout(() => abort.abort(), 50);
                        }
                    }
                } catch (error) {
                    ConnectError.from(error);
                }
                assert.ok(await settlesWithin(probe.finallyRan, 2_000), "the handler's finally must run");
                await sleep(300);
                assert.strictEqual(probe.finallyRuns(), 1);
                await server.stop();
            });
        });
    }

    describe(`leaving a stream loop over ${kind}`, () => {
        it("break alone does not abort the handler's signal", async () => {
            const { server, client, probe } = await start(kind, "yield-only");
            let seen = 0;
            for await (const _item of open(client, "server", new AbortController().signal)) {
                if (++seen === 2) {
                    break;
                }
            }
            await sleep(300);
            assert.strictEqual(probe.signalAborted(), false);
            assert.strictEqual(probe.finallyRuns(), 0);
            await server.stop();
        });
    });
}
