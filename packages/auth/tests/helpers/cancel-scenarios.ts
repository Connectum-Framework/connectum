/**
 * When a streaming call ends early, the handler's cleanup runs once, under the
 * identity of the call that is being cleaned up.
 *
 * A handler's `finally` is where cursors, subscriptions and locks are released,
 * and that code frequently needs the caller's identity (to audit, to scope a
 * release, to tag telemetry). Early ends are delivered by whoever happens to
 * notice them: a client abort arrives from a socket event, a deadline from a
 * timer, a stalled consumer from the consumer's own call. These tests end
 * server-streaming and bidi calls in each of those ways, behind every
 * authentication factory and over each transport, with two identities in flight
 * at once, and check what the cleanup observed, how often it ran and that
 * nothing stayed behind in the process.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { authContextStorage, getAuthContext } from "../../src/index.ts";
import { ItemSchema } from "../fixtures/streaming/v1/streaming_pb.ts";
import {
    AMBIENT_CALLER,
    type AuthFactoryName,
    type AuthSetup,
    boot,
    buildEndlessRoutes,
    clientFor,
    createAuthSetup,
    createJwksAuthSetup,
    createProbe,
    endlessInputs,
    eventually,
    identitiesFor,
    type Pace,
    type Probe,
    SLOW_AWAIT_MS,
    type StreamingClient,
    startJwksIssuer,
    type TestServer,
    type Transport,
    telemetryStorage,
} from "./stream-context.ts";

const ITERATIONS = Number(process.env.AUTH_STREAM_CANCEL_ITERATIONS ?? 25);
/** Rounds started together: enough overlap to interleave calls, few enough to stay clear of HTTP/2 reset-flood protection. */
const WAVE = 13;
/** Generous: the first message of a cold call takes well over 100 ms, and it must arrive before the deadline. */
const DEADLINE_MS = 1_000;

type EndKind = "server" | "bidi";
/** The ways a call can end before the handler is done. */
type EndMode = "abort-at-yield" | "abort-during-pending-next" | "deadline" | "early-break";

const MODES: ReadonlyArray<{ mode: EndMode; pace: Pace }> = [
    { mode: "abort-at-yield", pace: "yield-only" },
    { mode: "abort-during-pending-next", pace: "slow-await" },
    { mode: "deadline", pace: "yield-only" },
    { mode: "early-break", pace: "yield-only" },
];

const started: TestServer[] = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

function open(client: StreamingClient, kind: EndKind, headers: Record<string, string>, tag: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const callOptions = { headers: { ...headers, "x-tag": tag }, ...options };
    const first = create(ItemSchema, { value: tag, sequence: 0 });
    const stream = kind === "server" ? client.server(first, callOptions) : client.bidi(endlessInputs(tag), callOptions);
    return stream[Symbol.asyncIterator]();
}

/** Ends one call in the requested way; resolves once the caller has finished its own part. */
async function endCall(client: StreamingClient, kind: EndKind, mode: EndMode, headers: Record<string, string>, tag: string): Promise<void> {
    const abort = new AbortController();
    const iterator = open(client, kind, headers, tag, mode === "deadline" ? { timeoutMs: DEADLINE_MS } : { signal: abort.signal });
    const swallowed = (error: unknown) => {
        const code = ConnectError.from(error).code;
        assert.ok(code === Code.Canceled || code === Code.DeadlineExceeded, `unexpected failure ${Code[code]}: ${String(error)}`);
    };
    const first = await iterator.next();
    assert.strictEqual(first.done, false, "the call must deliver a message before it is ended");

    switch (mode) {
        case "abort-at-yield":
            // The handler has yielded and nobody pulls again: it is parked at `yield`.
            await sleep(10);
            abort.abort();
            await iterator.next().then(() => {}, swallowed);
            break;
        case "abort-during-pending-next": {
            // The handler is inside a timer that ignores the signal when the abort lands.
            const pending = iterator.next();
            await sleep(SLOW_AWAIT_MS / 4);
            abort.abort();
            await pending.then(() => {}, swallowed);
            break;
        }
        case "deadline":
            await sleep(DEADLINE_MS + 60);
            await iterator.next().then(() => {}, swallowed);
            break;
        case "early-break":
            await iterator.next();
            await iterator.return?.();
            break;
    }
}

function expectedCleanupIdentity(tag: string): string {
    return tag.split("#")[0] as string;
}

async function runEnd(options: { setup: AuthSetup; transport: Transport; kind: EndKind; mode: EndMode; pace: Pace; scenario: string }) {
    const { setup, transport, kind, mode, pace, scenario } = options;
    const probe: Probe = createProbe();
    // When a deadline expires while nobody is reading a server-streaming response, the Connect client
    // rejects a promise of its own that no one awaits. That is the client library reporting the very
    // deadline under test, so it is collected and checked below instead of failing the run.
    const clientDeadlines: unknown[] = [];
    const onUnhandled = (reason: unknown) => clientDeadlines.push(reason);
    if (mode === "deadline") {
        process.on("unhandledRejection", onUnhandled);
    }
    const server = await boot({ interceptors: [setup.interceptor], routes: buildEndlessRoutes(probe, pace) });
    started.push(server);
    const client = clientFor(server, transport);
    const telemetry = transport !== "http";
    const callerIdentity = transport === "local-ambient" ? AMBIENT_CALLER.subject : undefined;
    const callerViews = new Set<string | undefined>();
    const tags: string[] = [];

    const oneIdentity = async (identity: string, round: number) => {
        const tag = `${identity}#${round}`;
        tags.push(tag);
        const headers = await setup.headersFor(identity);
        const run = async () => {
            await endCall(client, kind, mode, headers, tag);
            callerViews.add(getAuthContext()?.subject);
        };
        const inTelemetry = () => (telemetry ? telemetryStorage.run(tag, run) : run());
        await (transport === "local-ambient" ? authContextStorage.run(AMBIENT_CALLER, inTelemetry) : inTelemetry());
    };

    for (let first = 0; first < ITERATIONS; first += WAVE) {
        const wave: Array<Promise<void>> = [];
        for (let round = first; round < Math.min(first + WAVE, ITERATIONS); round++) {
            wave.push(oneIdentity(`${scenario}-${round}-A`, round), oneIdentity(`${scenario}-${round}-B`, round));
        }
        await Promise.all(wave);
    }

    let cleanedBeforeStop = 0;
    if (mode === "early-break") {
        // Leaving the loop is not a cancellation: the handler stays parked at its last `yield` until
        // something else ends the call, here the server shutting down.
        await sleep(150);
        cleanedBeforeStop = probe.cleanups.size;
        await server.stop();
    }

    const allCleaned = await eventually(() => tags.every((tag) => (probe.cleanups.get(tag)?.count ?? 0) >= 1), 5_000);
    // Give a duplicate cleanup the chance to show up before counting.
    await sleep(50);

    process.off("unhandledRejection", onUnhandled);
    const foreignRejections = clientDeadlines.filter((reason) => ConnectError.from(reason).code !== Code.DeadlineExceeded);
    const wrongCount = tags.filter((tag) => probe.cleanups.get(tag)?.count !== 1);
    const wrongIdentity = tags.filter((tag) => probe.cleanups.get(tag)?.seen !== expectedCleanupIdentity(tag));
    const wrongTelemetry = telemetry ? tags.filter((tag) => probe.cleanups.get(tag)?.telemetry !== tag) : [];
    const duringCall = probe.observations.filter((o) => o.seen !== expectedCleanupIdentity(o.tag));
    return {
        calls: tags.length,
        allCleaned,
        cleanedBeforeStop,
        foreignRejections: foreignRejections.length,
        wrongCount: wrongCount.length,
        wrongIdentity: wrongIdentity.length,
        wrongTelemetry: wrongTelemetry.length,
        wrongDuringCall: duringCall.length,
        callerViews: [...callerViews],
        expectedCallerView: callerIdentity,
        example: { count: wrongCount[0], identity: wrongIdentity[0], observation: duringCall[0] },
    };
}

/** Registers the early-end scenarios for the given authentication factories. */
export function registerEndMatrix(factories: ReadonlyArray<AuthFactoryName | "jwt-jwks">): void {
    for (const factory of factories) {
        for (const transport of ["local", "local-ambient", "http"] as const) {
            for (const kind of ["server", "bidi"] as const) {
                describe(`${factory} over ${transport}: ${kind} ended early`, () => {
                    for (const { mode, pace } of MODES) {
                        it(`${mode}: cleanup runs once under the call's own identity`, { timeout: 120_000 }, async () => {
                            const scenario = `${factory}/${transport}/${kind}/${mode}`;
                            const issuer = factory === "jwt-jwks" ? await startJwksIssuer() : undefined;
                            try {
                                const setup = issuer ? createJwksAuthSetup(issuer) : createAuthSetup(factory as AuthFactoryName, identitiesFor(scenario, ITERATIONS));
                                const result = await runEnd({ setup, transport, kind, mode, pace, scenario });
                                assert.deepStrictEqual(
                                    {
                                        allCleaned: result.allCleaned,
                                        cleanedBeforeStop: result.cleanedBeforeStop,
                                        foreignRejections: result.foreignRejections,
                                        wrongCount: result.wrongCount,
                                        wrongIdentity: result.wrongIdentity,
                                        wrongTelemetry: result.wrongTelemetry,
                                        wrongDuringCall: result.wrongDuringCall,
                                    },
                                    { allCleaned: true, cleanedBeforeStop: 0, foreignRejections: 0, wrongCount: 0, wrongIdentity: 0, wrongTelemetry: 0, wrongDuringCall: 0 },
                                    JSON.stringify(result),
                                );
                                assert.deepStrictEqual(result.callerViews, [result.expectedCallerView], "the caller's own identity must be untouched after the call");
                            } finally {
                                await issuer?.close();
                            }
                        });
                    }
                });
            }
        }
    }
}

/** Registers the checks that early ends leave no resources or duplicate cleanups behind. */
export function registerLeftoverChecks(): void {
    describe("early ends leave nothing behind", () => {
        const snapshot = () => {
            const counts: Record<string, number> = {};
            for (const name of process.getActiveResourcesInfo()) {
                counts[name] = (counts[name] ?? 0) + 1;
            }
            return counts;
        };

        for (const transport of ["local", "http"] as const) {
            for (const kind of ["server", "bidi"] as const) {
                for (const { mode, pace } of MODES.filter((entry) => entry.mode !== "early-break")) {
                    it(`${transport} ${kind} ${mode}: active resources return to the baseline and cleanup runs exactly once per call`, { timeout: 120_000 }, async () => {
                        const probe = createProbe();
                        const setup = createAuthSetup("generic", []);
                        const server = await boot({ interceptors: [setup.interceptor], routes: buildEndlessRoutes(probe, pace) });
                        started.push(server);
                        const client = clientFor(server, transport);
                        const headers = await setup.headersFor("resource-check");

                        // One call first so connections, timers of the client library and lazily created state exist in the baseline.
                        await endCall(client, kind, mode, headers, "resource-check#warm");
                        await eventually(() => probe.cleanups.get("resource-check#warm")?.count === 1);
                        await sleep(200);
                        const before = snapshot();

                        const calls = 12;
                        for (let i = 0; i < calls; i++) {
                            await endCall(client, kind, mode, headers, `resource-check#${i}`);
                        }
                        await eventually(() => probe.cleanups.size === calls + 1, 5_000);
                        await sleep(300);

                        const duplicates = [...probe.cleanups.entries()].filter(([, entry]) => entry.count !== 1).map(([tag]) => tag);
                        assert.deepStrictEqual(duplicates, [], "every call is cleaned up exactly once");
                        assert.strictEqual(probe.cleanups.size, calls + 1);

                        let after = snapshot();
                        await eventually(() => {
                            after = snapshot();
                            return JSON.stringify(after) === JSON.stringify(before);
                        }, 5_000);
                        assert.deepStrictEqual(after, before, "no timers, sockets or handles are left over from the ended calls");
                    });
                }
            }
        }

        it("leaving the consumer loop early is not a cancellation: the handler stays parked until the server stops, then cleans up once under its own identity", async () => {
            const probe = createProbe();
            const setup = createAuthSetup("generic", []);
            const server = await boot({ interceptors: [setup.interceptor], routes: buildEndlessRoutes(probe, "yield-only") });
            started.push(server);
            const client = clientFor(server, "local");
            const headers = { ...(await setup.headersFor("breaker")), "x-tag": "breaker#0" };

            let received = 0;
            for await (const _message of client.server(create(ItemSchema, { value: "breaker#0", sequence: 0 }), { headers })) {
                received++;
                if (received === 3) {
                    break;
                }
            }
            await sleep(150);
            assert.strictEqual(received, 3);
            assert.strictEqual(probe.cleanups.size, 0, "break alone does not unwind the handler");
            await server.stop();
            await eventually(() => probe.cleanups.get("breaker#0")?.count === 1);
            await sleep(50);
            assert.strictEqual(probe.cleanups.get("breaker#0")?.count, 1);
            assert.strictEqual(probe.cleanups.get("breaker#0")?.seen, "breaker");
            // The handler resumed from its last yield exactly the number of times the consumer pulled.
            assert.deepStrictEqual(
                probe.observations.filter((o) => o.phase.startsWith("server-after-yield")).map((o) => o.phase),
                ["server-after-yield-0", "server-after-yield-1"],
            );
        });
    });
}
