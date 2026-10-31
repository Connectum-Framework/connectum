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

import assert from "node:assert";
import { create, createFileRegistry } from "@bufbuild/protobuf";
import type { GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import { FieldDescriptorProto_Label, FieldDescriptorProto_Type, FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
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

/**
 * Asserts the handler's own answer on both transports, then the structural parity.
 * Two transports that agree on a wrong answer (or on a truncated stream) must still fail.
 */
function expectOnBoth(expected: unknown) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        assert.deepStrictEqual(http.response, expected, "HTTP transport result");
        assert.deepStrictEqual(local.response, expected, "Local transport result");
        defaultCompare(http, local);
    };
}

// 4.1 Unary
transportParityTest("parity 4.1: unary RPC works identically", {
    services: [streamingRoutes()],
    scenario: async ({ transport }) => {
        const client = createClient(StreamingService, transport);
        const res = await client.echo(create(ItemSchema, { value: "hello", sequence: 7 }));
        return { response: { value: res.value, sequence: res.sequence } };
    },
    compare: expectOnBoth({ value: "echo:hello", sequence: 7 }),
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
    compare: expectOnBoth({
        items: [
            { value: "s:0", sequence: 0 },
            { value: "s:1", sequence: 1 },
            { value: "s:2", sequence: 2 },
        ],
    }),
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
    compare: expectOnBoth({ total: 3 }),
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
    compare: expectOnBoth({
        items: [
            { value: "bidi:b0", sequence: 0 },
            { value: "bidi:b1", sequence: 1 },
            { value: "bidi:b2", sequence: 2 },
        ],
    }),
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
                ac.abort();
            }
        } catch (err) {
            const code = err instanceof ConnectError ? err.code : -1;
            return { response: { received }, error: { code, message: "<canceled>" } };
        }
        // The loop ended without an error: the abort did not cancel the stream.
        return { response: { received } };
    },
    // The client aborts after the first message. Iteration stops there, with a
    // `canceled` error, on both transports: the same message count and the same
    // code, not merely "at least one message and the loop ended".
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.deepStrictEqual(result.response, { received: [0] }, `${name} transport must stop iterating after the message that preceded the abort`);
            assert.strictEqual(result.error?.code, Code.Canceled, `${name} transport must reject the aborted stream with Canceled`);
        }
        defaultCompare(http, local);
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

transportParityTest("parity 4.7: aborting a server stream runs the handler's cleanup", {
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
    // Equal pairs would also be `{ finallyRan: false, ... }` on both transports if the
    // cleanup never ran, so the expected values are spelled out: after an abort the
    // handler's `finally` ran and its signal was aborted.
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { finallyRan: true, signalAborted: true }, "HTTP transport must run the handler's cleanup after an abort");
        assert.deepStrictEqual(local.response, { finallyRan: true, signalAborted: true }, "Local transport must run the handler's cleanup after an abort");
        defaultCompare(http, local);
    },
});

const breakProbe = newProbe();
transportParityTest("parity 4.8: break followed by abort runs the handler's cleanup", {
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
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { finallyRan: true, signalAborted: true }, "HTTP transport must run the handler's cleanup after break and abort");
        assert.deepStrictEqual(local.response, { finallyRan: true, signalAborted: true }, "Local transport must run the handler's cleanup after break and abort");
        defaultCompare(http, local);
    },
});

// Leaving a `for await` loop with `break` ends the call (`@connectrpc/connect` 2.3.0 and
// later): with no abort by the caller, the handler's signal aborts and its cleanup runs on
// both transports.
const breakOnlyProbe = newProbe();
transportParityTest("parity: break alone aborts the handler's signal and runs its cleanup", {
    services: [observableStreamRoutes(breakOnlyProbe)],
    scenario: async ({ transport }) => {
        resetProbe(breakOnlyProbe);
        const client = createClient(StreamingService, transport);
        let seen = 0;
        // The caller's signal is never aborted: the loop exit is the only thing ending the call.
        for await (const _m of client.server(create(ItemSchema, { value: "s", sequence: 0 }), { signal: new AbortController().signal })) {
            if (++seen === 2) {
                break;
            }
        }
        return await handlerOutcome(breakOnlyProbe, 2_000);
    },
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { finallyRan: true, signalAborted: true }, "HTTP transport must end the call on break");
        assert.deepStrictEqual(local.response, { finallyRan: true, signalAborted: true }, "Local transport must end the call on break");
        defaultCompare(http, local);
    },
});

// server.stop() while a server stream is still sending. The handler ignores its signal and
// wants to send ten items; the stop arrives after three. A stream the server cuts must not
// end like a complete response, on either transport: the items sent before the stop arrive
// in order and the stream then fails with `unavailable`.
//
// The service is described at runtime because the shared streaming fixture declares a bidi
// method, and a server that mounts one refuses to start over plaintext HTTP/1.1, which is
// how the harness builds its in-process server when a scenario starts it to stop it.
{
    const field = (name: string, number: number, type: FieldDescriptorProto_Type) => ({ name, number, type, label: FieldDescriptorProto_Label.OPTIONAL, jsonName: name });
    const countFile = create(FileDescriptorProtoSchema, {
        name: "parity/v1/count.proto",
        package: "parity.v1",
        syntax: "proto3",
        messageType: [
            { name: "Req", field: [field("text", 1, FieldDescriptorProto_Type.STRING)] },
            { name: "Res", field: [field("n", 1, FieldDescriptorProto_Type.INT32)] },
        ],
        service: [{ name: "Counter", method: [{ name: "Count", inputType: ".parity.v1.Req", outputType: ".parity.v1.Res", serverStreaming: true }] }],
    });
    // The descriptor comes from the runtime registry, so its static type is the generic
    // `DescService`; the cast gives it the one method the handler and the client use.
    const registered = createFileRegistry(countFile, () => undefined).getService("parity.v1.Counter");
    assert.ok(registered, "the runtime service descriptor must exist");
    const counter = registered as unknown as GenService<{
        count: { methodKind: "server_streaming"; input: GenMessage<{ $typeName: "parity.v1.Req"; text: string }>; output: GenMessage<{ $typeName: "parity.v1.Res"; n: number }> };
    }>;

    const itemsWanted = 10;
    const stopAfter = 3;
    let reachedStopPoint = Promise.withResolvers<void>();
    transportParityTest("parity: server.stop() cutting a server stream ends it with Unavailable", {
        services: [
            defineService(counter, {
                async *count() {
                    for (let i = 0; i < itemsWanted; i++) {
                        yield { n: i };
                        if (i + 1 === stopAfter) {
                            reachedStopPoint.resolve();
                        }
                        await new Promise<void>((resolve) => setTimeout(resolve, 40));
                    }
                },
            }),
        ],
        scenario: async ({ transport, server, transportKind }) => {
            reachedStopPoint = Promise.withResolvers<void>();
            if (transportKind === "local") {
                // The local harness never binds a socket on its own; start it so it can be stopped.
                await server.start();
            }
            const received: number[] = [];
            const outcome = (async (): Promise<ParityScenarioResult> => {
                try {
                    for await (const item of createClient(counter, transport).count({})) {
                        received.push(item.n);
                    }
                } catch (err) {
                    const code = err instanceof ConnectError ? err.code : -1;
                    return { response: { received }, error: { code, message: "<cut>" } };
                }
                return { response: { received } };
            })();
            await reachedStopPoint.promise;
            await server.stop();
            return await outcome;
        },
        compare: (http, local) => {
            for (const [name, result] of [
                ["HTTP", http],
                ["local", local],
            ] as const) {
                assert.strictEqual(result.error?.code, Code.Unavailable, `${name} transport must tell the client the stream was cut`);
                const received = (result.response as { received: number[] }).received;
                assert.ok(received.length >= stopAfter && received.length < itemsWanted, `${name} transport: ${received.length} of ${itemsWanted} items`);
                assert.deepStrictEqual(
                    received,
                    Array.from({ length: received.length }, (_, i) => i),
                    `${name} transport: the items sent before the stop arrive in order`,
                );
            }
            assert.strictEqual(http.error?.code, local.error?.code);
        },
    });
}
