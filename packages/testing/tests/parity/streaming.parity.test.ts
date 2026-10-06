/**
 * Group 4 — Streaming & cancellation parity.
 *
 *   4.1 unary RPC
 *   4.2 server-streaming
 *   4.3 client-streaming
 *   4.4 bidi-streaming
 *   4.5 unary cancellation via AbortController
 *   4.6 streaming cancellation mid-stream
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { transportParityTest } from "../../src/transportParityTest.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

function streamingRoutes() {
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: `echo:${req.value}`, sequence: req.sequence }),
        // Server stream: yield N items based on req.sequence.
        async *server(req) {
            const n = req.sequence || 3;
            for (let i = 0; i < n; i++) {
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
            }
        },
        // Client stream: aggregate count of received items.
        async client(requests) {
            let total = 0;
            for await (const _item of requests) {
                total++;
            }
            return { total };
        },
        // Bidi: echo each received message.
        async *bidi(requests) {
            for await (const item of requests) {
                yield create(ItemSchema, { value: `bidi:${item.value}`, sequence: item.sequence });
            }
        },
    });
}

// 4.1 Unary
transportParityTest("parity 4.1: unary RPC works identically", {
    services: [streamingRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        const res = await client.echo(create(ItemSchema, { value: "hello", sequence: 7 }));
        return { response: { value: res.value, sequence: res.sequence } };
    },
});

// 4.2 Server-streaming
transportParityTest("parity 4.2: server-streaming yields N messages in order", {
    services: [streamingRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        const collected: Array<{ value: string; sequence: number }> = [];
        for await (const m of client.server(create(ItemSchema, { value: "s", sequence: 3 }))) {
            collected.push({ value: m.value, sequence: m.sequence });
        }
        return { response: { items: collected } };
    },
});

// 4.3 Client-streaming
transportParityTest("parity 4.3: client-streaming aggregates N inputs", {
    services: [streamingRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        async function* send() {
            for (let i = 0; i < 3; i++) {
                yield create(ItemSchema, { value: `c${i}`, sequence: i });
            }
        }
        const res = await client.client(send());
        return { response: { total: res.total } };
    },
});

// 4.4 Bidi-streaming
transportParityTest("parity 4.4: bidi-streaming echoes each message in order", {
    services: [streamingRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        async function* send() {
            for (let i = 0; i < 3; i++) {
                yield create(ItemSchema, { value: `b${i}`, sequence: i });
            }
        }
        const out: Array<{ value: string; sequence: number }> = [];
        for await (const m of client.bidi(send())) {
            out.push({ value: m.value, sequence: m.sequence });
        }
        return { response: { items: out } };
    },
});

// 4.5 Unary cancellation
function cancellableRoutes() {
    return defineService(StreamingService, {
        // Long-running unary that resolves only after signal abort.
        echo: (_req, ctx) => {
            return new Promise((_resolve, reject) => {
                ctx.signal.addEventListener("abort", () => {
                    reject(new ConnectError("aborted", Code.Canceled));
                });
            });
        },
        async *server(req) {
            let i = 0;
            while (true) {
                yield create(ItemSchema, { value: `${req.value}:${i}`, sequence: i });
                i++;
                await new Promise((r) => setTimeout(r, 20));
            }
        },
        async client() {
            return { total: 0 };
        },
        async *bidi(requests) {
            for await (const item of requests) {
                yield create(ItemSchema, { value: item.value, sequence: item.sequence });
            }
        },
    });
}

transportParityTest("parity 4.5: unary cancellation produces Code.Canceled", {
    services: [cancellableRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 50);
        try {
            await client.echo(create(ItemSchema, { value: "x", sequence: 0 }), { signal: ac.signal });
            return { response: { unreachable: true } };
        } catch (err) {
            const code = err instanceof ConnectError ? err.code : -1;
            return { error: { code, message: "<canceled>" } };
        }
    },
    compare: (http, local) => {
        if (http.error?.code !== Code.Canceled || local.error?.code !== Code.Canceled) {
            throw new Error(`expected Code.Canceled on both, got http=${http.error?.code} local=${local.error?.code}`);
        }
    },
});

// 4.6 Streaming cancellation mid-stream.
transportParityTest("parity 4.6: streaming cancellation stops iteration", {
    services: [cancellableRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        const ac = new AbortController();
        const received: number[] = [];
        try {
            for await (const m of client.server(create(ItemSchema, { value: "s", sequence: 0 }), { signal: ac.signal })) {
                received.push(m.sequence);
                if (received.length >= 1) {
                    ac.abort();
                }
            }
        } catch (err) {
            const code = err instanceof ConnectError ? err.code : -1;
            return { response: { received: received.length >= 1, terminated: true }, error: { code, message: "<canceled>" } };
        }
        return { response: { received: received.length >= 1, terminated: true } };
    },
    compare: (http, local) => {
        // Both should terminate (either cleanly or with Canceled). The key
        // parity invariant is that iteration stops after abort on both.
        if (!http.response || !local.response) {
            throw new Error("expected response on both");
        }
        const h = http.response as { received: boolean; terminated: boolean };
        const l = local.response as { received: boolean; terminated: boolean };
        if (!h.received || !l.received || !h.terminated || !l.terminated) {
            throw new Error(`expected terminated iteration; http=${JSON.stringify(h)} local=${JSON.stringify(l)}`);
        }
    },
});

// 4.7 / 4.8 Handler-side effect of cancellation. What the client sees after a
// cancelled stream is not enough: the handler's own cleanup (`finally`) and its
// context signal must behave the same on both transports.
interface HandlerProbe {
    finallyRan: boolean;
    signalAborted: boolean;
    settled: Promise<void>;
    settle: () => void;
}

function resetProbe(probe: HandlerProbe): void {
    probe.finallyRan = false;
    probe.signalAborted = false;
    probe.settled = new Promise<void>((resolve) => {
        probe.settle = resolve;
    });
}

function observableStreamRoutes(probe: HandlerProbe) {
    async function* items(value: string, signal: AbortSignal) {
        signal.addEventListener("abort", () => {
            probe.signalAborted = true;
        });
        try {
            for (let i = 0; ; i++) {
                yield create(ItemSchema, { value: `${value}:${i}`, sequence: i });
            }
        } finally {
            probe.finallyRan = true;
            probe.settle();
        }
    }
    return defineService(StreamingService, {
        echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        server: (req, ctx) => items(req.value, ctx.signal),
        client: async () => ({ total: 0 }),
        bidi: (_requests, ctx) => items("bidi", ctx.signal),
    });
}

/** Whether the handler's `finally` ran within `ms`, and whether its signal aborted. */
async function handlerOutcome(probe: HandlerProbe, ms: number) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        const finallyRan = await Promise.race([probe.settled.then(() => true), timeout]);
        return { response: { finallyRan, signalAborted: probe.signalAborted } };
    } finally {
        clearTimeout(timer);
    }
}

function newProbe(): HandlerProbe {
    const probe = { finallyRan: false, signalAborted: false, settled: Promise.resolve(), settle: () => {} };
    resetProbe(probe);
    return probe;
}

const abortProbe = newProbe();
// Bun's HTTP/2 server does not unwind the handler on client cancellation, so
// the HTTP side of these two scenarios has no reference behaviour there.
const httpUnwindsOnCancel = !("bun" in process.versions);

const cleanupParity = httpUnwindsOnCancel ? transportParityTest : (_name: string, _options: unknown) => {};

cleanupParity("parity 4.7: aborting a server stream runs the handler's cleanup", {
    services: [observableStreamRoutes(abortProbe)],
    scenario: async ({ transport }) => {
        resetProbe(abortProbe);
        const client = createClient(StreamingService, transport);
        const ac = new AbortController();
        let seen = 0;
        try {
            for await (const _m of client.server(create(ItemSchema, { value: "s", sequence: 0 }), { signal: ac.signal })) {
                if (++seen === 2) {
                    ac.abort();
                }
            }
        } catch {
            // the client-side outcome of a cancelled stream is covered by the previous scenario
        }
        return await handlerOutcome(abortProbe, 2_000);
    },
});

const breakProbe = newProbe();
cleanupParity("parity 4.8: break followed by abort runs the handler's cleanup", {
    services: [observableStreamRoutes(breakProbe)],
    scenario: async ({ transport }) => {
        resetProbe(breakProbe);
        const client = createClient(StreamingService, transport);
        const ac = new AbortController();
        let seen = 0;
        for await (const _m of client.server(create(ItemSchema, { value: "s", sequence: 0 }), { signal: ac.signal })) {
            if (++seen === 2) {
                break;
            }
        }
        ac.abort();
        return await handlerOutcome(breakProbe, 2_000);
    },
});
