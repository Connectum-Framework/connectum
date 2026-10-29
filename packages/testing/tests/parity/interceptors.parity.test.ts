/**
 * Group 3 — Interceptor compatibility parity.
 *
 *   3.1 Server-side interceptor ordering identical on both transports.
 *   3.2 Client-side interceptors passed to the parity driver reach the server on both transports.
 *   3.3 Each interceptor from @connectum/interceptors has its documented effect on both
 *       transports (timeout, retry, bulkhead, circuit breaker, logger, serializer).
 *
 * 3.3 imports `@connectum/interceptors`, a devDependency of this package.
 */

import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import {
    createBulkheadInterceptor,
    createCircuitBreakerInterceptor,
    createLoggerInterceptor,
    createRetryInterceptor,
    createSerializerInterceptor,
    createTimeoutInterceptor,
} from "@connectum/interceptors";
import { defaultCompare, type ParityScenarioResult, type TransportKind, transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

function echoRoutes() {
    return defineService(EchoService, {
        echo: (req, ctx) => {
            // Forward observed interceptor order header into response header
            // so client can compare it across transports.
            const trace = ctx.requestHeader.get("x-trace") ?? "";
            ctx.responseHeader.set("x-server-trace", trace);
            return create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n });
        },
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

/** Routes whose `echo` is driven by a caller-supplied behaviour (the other methods are unused). */
function behaviourRoutes(echo: (message: string, signal: AbortSignal) => Promise<string> | string) {
    return defineService(EchoService, {
        echo: async (req, ctx) => create(EchoResponseSchema, { message: await echo(req.message, ctx.signal), timestamp: 0n }),
        secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    });
}

/** Calls `echo` and reports either the response message or the failure's code and text. */
async function outcome(client: ReturnType<typeof createClient<typeof EchoService>>, message: string, headers?: HeadersInit): Promise<{ message: string } | { code: number; text: string }> {
    try {
        const res = await client.echo(create(EchoRequestSchema, { message }), headers ? { headers } : undefined);
        return { message: res.message };
    } catch (err) {
        const e = ConnectError.from(err);
        return { code: e.code, text: e.rawMessage };
    }
}

/** Asserts the same absolute `expected` was reported by both transports, then the structural parity. */
function expectOnBoth(expected: unknown) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        assert.deepStrictEqual(http.response, expected, "HTTP transport result");
        assert.deepStrictEqual(local.response, expected, "Local transport result");
        defaultCompare(http, local);
    };
}

function makeOrderingInterceptor(tag: string): Interceptor {
    return (next) => async (req) => {
        const prev = req.header.get("x-trace") ?? "";
        req.header.set("x-trace", `${prev}${prev ? "," : ""}${tag}-pre`);
        const res = await next(req);
        const existing = res.header.get("x-server-post") ?? "";
        res.header.set("x-server-post", `${existing}${existing ? "," : ""}${tag}-post`);
        return res;
    };
}

// 3.1 — Server-side ordering. Interceptors [A, B] run A → B around the handler: the
// request passes A then B on the way in, and the response passes B then A on the way out.
transportParityTest("parity 3.1: server-side interceptor order is identical", {
    services: [echoRoutes()],
    interceptors: [makeOrderingInterceptor("A"), makeOrderingInterceptor("B")],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const headers = new Headers();
        const res = await client.echo(create(EchoRequestSchema, { message: "ping" }), {
            onHeader: (h) => {
                for (const [k, v] of h) headers.set(k, v);
            },
        });
        return {
            response: { message: res.message },
            responseHeaders: {
                "x-server-trace": headers.get("x-server-trace") ?? "",
                "x-server-post": headers.get("x-server-post") ?? "",
            },
        };
    },
    compare: (http, local) => {
        const expected = { "x-server-trace": "A-pre,B-pre", "x-server-post": "B-post,A-post" };
        assert.deepStrictEqual(http.responseHeaders, expected, "HTTP transport must run A before B on the way in and B before A on the way out");
        assert.deepStrictEqual(local.responseHeaders, expected, "Local transport must run A before B on the way in and B before A on the way out");
        defaultCompare(http, local);
    },
});

// 3.2 — Client-side interceptors passed to the driver are applied on the client of both
// transports (createGrpcTransport({ interceptors }) and createLocalTransport(server,
// { interceptors })), and what they set on the request is what the server sees.
transportParityTest("parity 3.2: client-side interceptor injection round-trips identically", {
    services: [echoRoutes()],
    clientInterceptors: [
        (next) => async (req) => {
            req.header.set("x-trace", "client-pre");
            return next(req);
        },
    ],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const headers = new Headers();
        const res = await client.echo(create(EchoRequestSchema, { message: "ping" }), {
            onHeader: (h) => {
                for (const [k, v] of h) headers.set(k, v);
            },
        });
        return {
            response: { message: res.message },
            responseHeaders: { "x-server-trace": headers.get("x-server-trace") ?? "" },
        };
    },
    compare: (http, local) => {
        const expected = { "x-server-trace": "client-pre" };
        assert.deepStrictEqual(http.responseHeaders, expected, "the header set by the client interceptor must reach the server over HTTP");
        assert.deepStrictEqual(local.responseHeaders, expected, "the header set by the client interceptor must reach the server in-process");
        defaultCompare(http, local);
    },
});

// 3.3 — Each interceptor from @connectum/interceptors does what its documentation says,
// identically on both transports.

// timeout: a handler slower than `duration` is cut off with DeadlineExceeded; a fast one is untouched.
transportParityTest("parity 3.3a: timeout interceptor cuts off a slow handler with DeadlineExceeded", {
    services: [behaviourRoutes(async (message, signal) => (message === "slow" ? sleep(2_000, "late", { signal }) : `done:${message}`))],
    interceptors: [createTimeoutInterceptor({ duration: 100 })],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        return { response: { fast: await outcome(client, "fast"), slow: await outcome(client, "slow") } };
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            const { fast, slow } = result.response as { fast: unknown; slow: { code?: number } };
            assert.deepStrictEqual(fast, { message: "done:fast" }, `${name} transport must serve a call within the duration`);
            assert.strictEqual(slow.code, Code.DeadlineExceeded, `${name} transport must reject a call past the duration with DeadlineExceeded`);
        }
        defaultCompare(http, local);
    },
});

// retry: a transient failure (Unavailable) is retried up to maxRetries after the first attempt;
// codes outside retryableCodes are not retried.
const retryAttempts = new Map<string, number>();
transportParityTest("parity 3.3b: retry interceptor retries Unavailable up to maxRetries and nothing else", {
    services: [
        behaviourRoutes((message) => {
            const attempt = (retryAttempts.get(message) ?? 0) + 1;
            retryAttempts.set(message, attempt);
            if (message.startsWith("flaky") && attempt === 1) throw new ConnectError("try again", Code.Unavailable);
            if (message.startsWith("down")) throw new ConnectError("still down", Code.Unavailable);
            if (message.startsWith("invalid")) throw new ConnectError("bad input", Code.InvalidArgument);
            return `done:${message}`;
        }),
    ],
    interceptors: [createRetryInterceptor({ maxRetries: 1, initialDelay: 1, maxDelay: 2 })],
    scenario: async ({ transport, transportKind }) => {
        const client = createClient(EchoService, transport);
        const keys = { flaky: `flaky-${transportKind}`, down: `down-${transportKind}`, invalid: `invalid-${transportKind}` };
        const result = {
            flaky: await outcome(client, keys.flaky),
            down: await outcome(client, keys.down),
            invalid: await outcome(client, keys.invalid),
            attempts: { flaky: retryAttempts.get(keys.flaky), down: retryAttempts.get(keys.down), invalid: retryAttempts.get(keys.invalid) },
        };
        // The keys differ per transport; report them without the transport suffix.
        return { response: JSON.parse(JSON.stringify(result).replaceAll(`-${transportKind}`, "")) };
    },
    compare: expectOnBoth({
        flaky: { message: "done:flaky" },
        down: { code: Code.Unavailable, text: "still down" },
        invalid: { code: Code.InvalidArgument, text: "bad input" },
        // flaky: failed once, retried once; down: initial attempt plus maxRetries; invalid: not retryable.
        attempts: { flaky: 2, down: 2, invalid: 1 },
    }),
});

// bulkhead: with capacity 1 and no queue, a second concurrent call is rejected with
// ResourceExhausted while the first is in flight, and the slot is free again afterwards.
const holds = new Map<TransportKind, { entered: Promise<void>; markEntered: () => void; release: () => void; released: Promise<void> }>();
function holdFor(kind: TransportKind) {
    let hold = holds.get(kind);
    if (!hold) {
        let markEntered = () => {};
        let release = () => {};
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        hold = { entered, markEntered, release, released };
        holds.set(kind, hold);
    }
    return hold;
}
transportParityTest("parity 3.3c: bulkhead interceptor rejects the call beyond capacity with ResourceExhausted", {
    services: [
        behaviourRoutes(async (message) => {
            if (message.startsWith("hold-")) {
                const hold = holdFor(message.slice("hold-".length) as TransportKind);
                hold.markEntered();
                await hold.released;
            }
            return `done:${message}`;
        }),
    ],
    interceptors: [createBulkheadInterceptor({ capacity: 1, queueSize: 0 })],
    scenario: async ({ transport, transportKind }) => {
        const client = createClient(EchoService, transport);
        const hold = holdFor(transportKind);
        const first = outcome(client, `hold-${transportKind}`);
        await hold.entered;
        const second = await outcome(client, "second");
        hold.release();
        const firstResult = await first;
        const third = await outcome(client, "third");
        return { response: { first: JSON.parse(JSON.stringify(firstResult).replaceAll(`-${transportKind}`, "")), second, third } };
    },
    compare: (http, local) => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            const { first, second, third } = result.response as { first: unknown; second: { code?: number }; third: unknown };
            assert.deepStrictEqual(first, { message: "done:hold" }, `${name} transport must complete the call holding the slot`);
            assert.strictEqual(second.code, Code.ResourceExhausted, `${name} transport must reject the concurrent call beyond capacity`);
            assert.deepStrictEqual(third, { message: "done:third" }, `${name} transport must free the slot after the first call finishes`);
        }
        defaultCompare(http, local);
    },
});

// bulkhead: a call that waits in the queue and is abandoned by its client leaves the queue and
// never reaches the handler. Capacity 1, queue 1: A holds the slot, B queues and is cancelled,
// C then arrives while A still runs. C must be queued (and run after A), not refused with
// ResourceExhausted because the dead B still occupied the queue.
interface Gate {
    entered: Promise<void>;
    markEntered: () => void;
    release: () => void;
    released: Promise<void>;
}
const gates = new Map<string, Gate>();
function gateFor(key: string): Gate {
    let gate = gates.get(key);
    if (!gate) {
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        gate = { entered: entered.promise, markEntered: entered.resolve, release: released.resolve, released: released.promise };
        gates.set(key, gate);
    }
    return gate;
}
const handlerStarts = new Map<TransportKind, string[]>();
const interceptorEvents = new Map<string, PromiseWithResolvers<void>>();
function eventFor(key: string): PromiseWithResolvers<void> {
    let event = interceptorEvents.get(key);
    if (!event) {
        event = Promise.withResolvers<void>();
        interceptorEvents.set(key, event);
    }
    return event;
}
/** Outside the bulkhead: reports when a call arrives at it and when the call has ended on the server side. */
const observeCalls: Interceptor = (next) => async (req) => {
    const [kind, name] = (req.message as unknown as { message: string }).message.split("|") as [string, string];
    eventFor(`${kind}|${name}|arrived`).resolve();
    try {
        return await next(req);
    } finally {
        eventFor(`${kind}|${name}|ended`).resolve();
    }
};
transportParityTest("parity 3.3c2: bulkhead drops a queued call its client abandoned and never runs its handler", {
    services: [
        behaviourRoutes(async (message) => {
            const [kind, name] = message.split("|") as [TransportKind, string];
            handlerStarts.set(kind, [...(handlerStarts.get(kind) ?? []), name]);
            const gate = gateFor(`${kind}|${name}`);
            gate.markEntered();
            await gate.released;
            return `done:${name}`;
        }),
    ],
    interceptors: [observeCalls, createBulkheadInterceptor({ capacity: 1, queueSize: 1 })],
    scenario: async ({ transport, transportKind: kind }) => {
        const client = createClient(EchoService, transport);
        try {
            return await abandonedWaiter(client, kind);
        } finally {
            // A regression would leave the abandoned call's handler running; let it end so the server can stop.
            for (const name of ["A", "B", "C"]) gateFor(`${kind}|${name}`).release();
        }
    },
    compare: expectOnBoth({
        a: { message: "done:A" },
        b: { code: Code.Canceled },
        c: { message: "done:C" },
        // B never started; C started only after A had released the slot.
        handlerStarts: ["A", "C"],
    }),
});
async function abandonedWaiter(client: ReturnType<typeof createClient<typeof EchoService>>, kind: TransportKind): Promise<{ response: unknown }> {
    const a = outcome(client, `${kind}|A`);
    await gateFor(`${kind}|A`).entered;

    const cancelB = new AbortController();
    const b = client.echo(create(EchoRequestSchema, { message: `${kind}|B` }), { signal: cancelB.signal }).then(
        () => ({ settled: "ok" }),
        (err: unknown) => ({ code: ConnectError.from(err).code }),
    );
    await eventFor(`${kind}|B|arrived`).promise;
    cancelB.abort();
    const bResult = await b;
    // The server has to see the abandoned call end before C arrives, or C could still meet the
    // dead entry. With the fix this resolves at once; the bound only keeps a regression from hanging the run.
    const giveUp = new Promise<void>((resolve) => AbortSignal.timeout(3000).addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([eventFor(`${kind}|B|ended`).promise, giveUp]);

    const c = outcome(client, `${kind}|C`);
    await eventFor(`${kind}|C|arrived`).promise;
    gateFor(`${kind}|A`).release();
    const aResult = await a;
    // C runs once A has released the slot. If it was refused instead, `c` is already settled.
    const afterA = await Promise.race([c, gateFor(`${kind}|C`).entered.then(() => "entered" as const)]);
    if (afterA === "entered") {
        gateFor(`${kind}|C`).release();
    }
    return { response: { a: aResult, b: bResult, c: await c, handlerStarts: handlerStarts.get(kind) } };
}

// circuit breaker: after `threshold` consecutive infrastructure failures the circuit opens and
// the next call is rejected with Unavailable without reaching the handler. The breaker keeps
// its state for the life of the interceptor, so each run gets its own instance, picked by a
// request header the scenario sets.
const breakerHandlerCalls = new Map<string, number>();
function perRunBreaker(): Interceptor {
    const instances = new Map<string, Interceptor>();
    return (next) => (req) => {
        const run = req.header.get("x-run") ?? "";
        let instance = instances.get(run);
        if (!instance) {
            instance = createCircuitBreakerInterceptor({ threshold: 2, halfOpenAfter: 60_000 });
            instances.set(run, instance);
        }
        return instance(next)(req);
    };
}
transportParityTest("parity 3.3d: circuit-breaker interceptor opens after threshold failures and stops calling the handler", {
    services: [
        behaviourRoutes((message) => {
            const [kind] = message.split("|") as [string];
            breakerHandlerCalls.set(kind, (breakerHandlerCalls.get(kind) ?? 0) + 1);
            if (message.endsWith("|fail")) throw new ConnectError("upstream broke", Code.Internal);
            return `done:${message}`;
        }),
    ],
    interceptors: [perRunBreaker()],
    scenario: async ({ transport, transportKind }) => {
        const client = createClient(EchoService, transport);
        const headers = { "x-run": transportKind };
        const first = await outcome(client, `${transportKind}|fail`, headers);
        const second = await outcome(client, `${transportKind}|fail`, headers);
        const afterOpen = await outcome(client, `${transportKind}|ok`, headers);
        return { response: { first, second, afterOpen: { code: (afterOpen as { code?: number }).code }, handlerCalls: breakerHandlerCalls.get(transportKind) } };
    },
    compare: expectOnBoth({
        first: { code: Code.Internal, text: "upstream broke" },
        second: { code: Code.Internal, text: "upstream broke" },
        afterOpen: { code: Code.Unavailable },
        // Only the two failing calls reached the handler; the call after the circuit opened did not.
        handlerCalls: 2,
    }),
});

// circuit breaker, half-open: once the open period has passed, exactly one call is the probe;
// callers that arrive while it is still running are rejected at once with Unavailable instead of
// waiting for it, and a successful probe closes the circuit. `halfOpenAfter: 0` makes the very next
// call the probe, so the scenario needs no clock.
function perRunProbeBreaker(): Interceptor {
    const instances = new Map<string, Interceptor>();
    return (next) => (req) => {
        const run = req.header.get("x-run") ?? "";
        let instance = instances.get(run);
        if (!instance) {
            instance = createCircuitBreakerInterceptor({ threshold: 1, halfOpenAfter: 0 });
            instances.set(run, instance);
        }
        return instance(next)(req);
    };
}
const probeHandlerCalls = new Map<string, string[]>();
transportParityTest("parity 3.3d2: circuit-breaker half-open rejects callers that arrive during the probe at once", {
    services: [
        behaviourRoutes(async (message) => {
            const [kind, name] = message.split("|") as [TransportKind, string];
            probeHandlerCalls.set(kind, [...(probeHandlerCalls.get(kind) ?? []), name]);
            if (name === "fail") throw new ConnectError("upstream broke", Code.Internal);
            if (name === "probe") {
                const gate = gateFor(`${kind}|probe`);
                gate.markEntered();
                await gate.released;
            }
            return `done:${name}`;
        }),
    ],
    interceptors: [perRunProbeBreaker()],
    scenario: async ({ transport, transportKind: kind }) => {
        const client = createClient(EchoService, transport);
        const headers = { "x-run": kind };
        try {
            const failed = await outcome(client, `${kind}|fail`, headers);
            const probe = outcome(client, `${kind}|probe`, headers);
            await gateFor(`${kind}|probe`).entered;

            // A regression leaves these callers waiting for the probe, which only ends below: the bound keeps the run from hanging.
            const giveUp = new Promise<string>((resolve) => AbortSignal.timeout(3000).addEventListener("abort", () => resolve("still waiting"), { once: true }));
            const during = await Promise.all([1, 2].map((n) => Promise.race([outcome(client, `${kind}|during${n}`, headers), giveUp])));

            gateFor(`${kind}|probe`).release();
            const probeResult = await probe;
            const after = await outcome(client, `${kind}|after`, headers);
            return {
                response: {
                    failed,
                    during: during.map((result) => (typeof result === "string" ? result : { code: (result as { code?: number }).code })),
                    probe: probeResult,
                    after,
                    handlerCalls: probeHandlerCalls.get(kind),
                },
            };
        } finally {
            gateFor(`${kind}|probe`).release();
        }
    },
    compare: expectOnBoth({
        failed: { code: Code.Internal, text: "upstream broke" },
        during: [{ code: Code.Unavailable }, { code: Code.Unavailable }],
        probe: { message: "done:probe" },
        after: { message: "done:after" },
        // The two callers that arrived during the probe never reached the handler.
        handlerCalls: ["fail", "probe", "after"],
    }),
});

// logger: every call writes a request line, a response line and a completion line.
const loggedLines: string[] = [];
transportParityTest("parity 3.3e: logger interceptor writes the request, response and completion lines", {
    services: [echoRoutes()],
    interceptors: [createLoggerInterceptor({ logger: (message) => void loggedLines.push(message) })],
    scenario: async ({ transport }) => {
        const start = loggedLines.length;
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "lg" }));
        return { response: { message: res.message, lines: loggedLines.slice(start).map((line) => line.replace(/completed in [\d.]+ms$/, "completed in <ms>")) } };
    },
    compare: expectOnBoth({
        message: "echo:lg",
        lines: ["RPC /echo.v1.EchoService/Echo request", "RPC /echo.v1.EchoService/Echo response", "RPC /echo.v1.EchoService/Echo completed in <ms>"],
    }),
});

// serializer: the handler behind it receives the request as its protobuf JSON shape, not as a
// protobuf message, and the response it returns is converted back into a message for the client.
transportParityTest("parity 3.3f: serializer interceptor hands the handler the JSON form of the request", {
    services: [
        defineService(EchoService, {
            echo: (req) => {
                const isMessage = "$typeName" in (req as object);
                return create(EchoResponseSchema, { message: `${isMessage ? "message" : "json"}:${req.message}`, timestamp: 0n });
            },
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        }),
    ],
    interceptors: [createSerializerInterceptor({})],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "sz" }));
        return { response: { message: res.message } };
    },
    compare: expectOnBoth({ message: "json:sz" }),
});

// serializer with strict unknown-field handling: the option set the guide shows must not reject the
// protobuf message a real handler returns (it carries a `$typeName` marker), so a valid call succeeds.
transportParityTest("parity 3.3g: serializer with ignoreUnknownFields=false serves a valid call on both transports", {
    services: [echoRoutes()],
    interceptors: [createSerializerInterceptor({ alwaysEmitImplicit: true, ignoreUnknownFields: false })],
    scenario: async ({ transport }) => {
        const client = createClient(EchoService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "strict" }));
        return { response: { message: res.message } };
    },
    compare: expectOnBoth({ message: "echo:strict" }),
});
