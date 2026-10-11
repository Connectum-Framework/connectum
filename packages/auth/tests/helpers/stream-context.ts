/**
 * Shared harness for the authentication context-lifetime acceptance tests.
 *
 * It builds a real `createServer()` around the streaming fixture service, puts
 * one of the framework's authentication factories in front of it, and lets the
 * handlers record which verified identity (and which independent telemetry
 * scope) they observe at every phase of every call kind. The same module is
 * loaded by the in-process tests and by the child process of the cross-process
 * tests, so both sides observe exactly the same handlers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextImmediate, setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer, defineService } from "@connectum/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
    authContextStorage,
    createAuthInterceptor,
    createGatewayAuthInterceptor,
    createInternalAuthInterceptor,
    createJwtAuthInterceptor,
    createSessionAuthInterceptor,
    getAuthContext,
    meshIdentityTrust,
} from "../../src/index.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { startTestJwksServer } from "../../src/testing/test-jwt-rs256.ts";
import type { AuthContext } from "../../src/types.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

export { StreamingService };

/** The four RPC kinds the fixture service offers. */
export type Kind = "unary" | "client" | "server" | "bidi";

/**
 * How the caller reaches the server.
 * - `local`: `server.localClient()` from a context without any auth identity.
 * - `local-ambient`: `localClient()` called while the caller itself holds a different verified identity.
 * - `http`: a real HTTP/2 connection to the server's port.
 */
export type Transport = "local" | "local-ambient" | "http";

/** Every authentication factory that establishes an AsyncLocalStorage identity. */
export type AuthFactoryName = "generic" | "generic-cache" | "jwt-secret" | "session" | "session-cache" | "gateway" | "internal";

export const SERVICE_NAME = "streaming.v1.StreamingService";

/** The identity a caller holds in the `local-ambient` transport. It must never reach a handler. */
export const AMBIENT_CALLER: AuthContext = { subject: "AMBIENT-CALLER", roles: [], scopes: [], claims: {}, type: "ambient" };

/** A storage that stands for an unrelated telemetry/timeout scope owned by the caller. */
export const telemetryStorage = new AsyncLocalStorage<string>();

export interface Observation {
    /** `<identity>#<call number>`: the value the handler read from the `x-tag` request header. */
    tag: string;
    phase: string;
    /** Subject of the verified identity visible at that point, if any. */
    seen: string | undefined;
    /** Value of the unrelated telemetry storage visible at that point, if any. */
    telemetry: string | undefined;
}

export interface Cleanup {
    count: number;
    /** Identity visible inside the handler's `finally` of the last run. */
    seen: string | undefined;
    telemetry: string | undefined;
}

export interface Probe {
    observations: Observation[];
    cleanups: Map<string, Cleanup>;
    record(tag: string, phase: string): void;
    cleanup(tag: string): void;
    reset(): void;
}

export function createProbe(): Probe {
    const observations: Observation[] = [];
    const cleanups = new Map<string, Cleanup>();
    return {
        observations,
        cleanups,
        record(tag, phase) {
            observations.push({ tag, phase, seen: getAuthContext()?.subject, telemetry: telemetryStorage.getStore() });
        },
        cleanup(tag) {
            const entry = cleanups.get(tag) ?? { count: 0, seen: undefined, telemetry: undefined };
            entry.count++;
            entry.seen = getAuthContext()?.subject;
            entry.telemetry = telemetryStorage.getStore();
            cleanups.set(tag, entry);
        },
        reset() {
            observations.length = 0;
            cleanups.clear();
        },
    };
}

/** Yields to the event loop in one of three different ways so continuations interleave. */
export async function jitter(): Promise<void> {
    const r = Math.random();
    if (r < 0.34) {
        await nextImmediate();
    } else if (r < 0.67) {
        await sleep(1);
    } else {
        await Promise.resolve();
    }
}

/** How many messages the finite server/bidi handlers produce. */
export const STREAM_LENGTH = 3;

export function tagOf(ctx: { requestHeader: Headers }): string {
    return ctx.requestHeader.get("x-tag") ?? "NO-TAG";
}

/** Handlers that record the identity they see at every phase of every call kind. */
export function buildRoutes(probe: Probe) {
    return defineService(StreamingService, {
        echo: async (req, ctx) => {
            const tag = tagOf(ctx);
            probe.record(tag, "unary-start");
            await jitter();
            probe.record(tag, "unary-after-await");
            return create(ItemSchema, { value: req.value, sequence: req.sequence });
        },
        client: async (requests, ctx) => {
            const tag = tagOf(ctx);
            probe.record(tag, "client-start");
            let count = 0;
            for await (const _message of requests) {
                probe.record(tag, `client-after-input-${count++}`);
                await jitter();
            }
            probe.record(tag, "client-end");
            return create(CountSchema, { total: count });
        },
        server: async function* (_req, ctx) {
            const tag = tagOf(ctx);
            probe.record(tag, "server-start");
            await jitter();
            probe.record(tag, "server-after-await");
            try {
                for (let i = 0; i < STREAM_LENGTH; i++) {
                    probe.record(tag, `server-before-yield-${i}`);
                    yield create(ItemSchema, { value: tag, sequence: i });
                    probe.record(tag, `server-after-yield-${i}`);
                    await jitter();
                    probe.record(tag, `server-after-await-${i}`);
                }
            } finally {
                probe.record(tag, "server-finally");
                probe.cleanup(tag);
            }
        },
        bidi: async function* (requests, ctx) {
            const tag = tagOf(ctx);
            probe.record(tag, "bidi-start");
            try {
                let i = 0;
                for await (const message of requests) {
                    probe.record(tag, `bidi-after-input-${i}`);
                    await jitter();
                    yield create(ItemSchema, { value: message.value, sequence: i });
                    probe.record(tag, `bidi-after-yield-${i}`);
                    i++;
                }
                probe.record(tag, "bidi-end");
            } finally {
                probe.record(tag, "bidi-finally");
                probe.cleanup(tag);
            }
        },
    });
}

/** The phases each kind must report for a call to count as exercised (guards against a vacuous run). */
export const EXPECTED_PHASES: Record<Kind, string[]> = {
    unary: ["unary-start", "unary-after-await"],
    client: ["client-start", "client-after-input-0", "client-end"],
    server: ["server-start", "server-after-await", "server-before-yield-0", "server-after-yield-0", "server-after-await-2", "server-finally"],
    bidi: ["bidi-start", "bidi-after-input-0", "bidi-after-yield-0", "bidi-end", "bidi-finally"],
};

// ---------------------------------------------------------------------------
// Authentication factories under test
// ---------------------------------------------------------------------------

export interface AuthSetup {
    name: string;
    interceptor: Interceptor;
    /** Request headers that authenticate `identity` (and nothing else). */
    headersFor(identity: string): Promise<Record<string, string>>;
    /** How many times the credential/session verifier ran for `identity` (0 for factories without one). */
    verifications(identity: string): number;
}

const GATEWAY_SECRET = "gateway-shared-secret";

function verificationCounter() {
    const counts = new Map<string, number>();
    return {
        hit(identity: string): void {
            counts.set(identity, (counts.get(identity) ?? 0) + 1);
        },
        get(identity: string): number {
            return counts.get(identity) ?? 0;
        },
    };
}

function contextFor(subject: string, type: string): AuthContext {
    return { subject, roles: [], scopes: [], claims: {}, type };
}

/**
 * Build one authentication factory. `identities` lists every subject the test
 * will authenticate: the internal factory's allow-list is static, the others
 * accept any identity.
 */
export function createAuthSetup(name: AuthFactoryName, identities: readonly string[]): AuthSetup {
    const counter = verificationCounter();
    const bearer = async (identity: string) => ({ authorization: `Bearer ${identity}` });
    const verifications = (identity: string) => counter.get(identity);

    switch (name) {
        case "generic":
        case "generic-cache":
            return {
                name,
                interceptor: createAuthInterceptor({
                    verifyCredentials: (token) => {
                        counter.hit(token);
                        return contextFor(token, "generic");
                    },
                    ...(name === "generic-cache" ? { cache: { ttl: 60_000 } } : {}),
                }),
                headersFor: bearer,
                verifications,
            };
        case "jwt-secret":
            return {
                name,
                interceptor: createJwtAuthInterceptor({ secret: TEST_JWT_SECRET }),
                headersFor: async (identity) => ({ authorization: `Bearer ${await createTestJwt({ sub: identity })}` }),
                verifications,
            };
        case "session":
        case "session-cache":
            return {
                name,
                interceptor: createSessionAuthInterceptor({
                    verifySession: (token) => {
                        counter.hit(token);
                        return { user: token };
                    },
                    mapSession: (session) => contextFor((session as { user: string }).user, "session"),
                    ...(name === "session-cache" ? { cache: { ttl: 60_000 } } : {}),
                }),
                headersFor: bearer,
                verifications,
            };
        case "gateway":
            return {
                name,
                interceptor: createGatewayAuthInterceptor({
                    headerMapping: { subject: "x-user-id" },
                    trustSource: { header: "x-gateway-secret", expectedValues: [GATEWAY_SECRET] },
                }),
                headersFor: async (identity) => ({ "x-gateway-secret": GATEWAY_SECRET, "x-user-id": identity }),
                verifications,
            };
        case "internal":
            return {
                name,
                interceptor: createInternalAuthInterceptor({
                    internalMethods: [`${SERVICE_NAME}/*`],
                    trustSource: meshIdentityTrust({ allowlist: identities.map((principal) => ({ principal })) }),
                }),
                headersFor: async (identity) => ({ "x-forwarded-client-principal": identity }),
                verifications,
            };
    }
}

export const AUTH_FACTORY_NAMES: readonly AuthFactoryName[] = ["generic", "generic-cache", "jwt-secret", "session", "session-cache", "gateway", "internal"];

// ---------------------------------------------------------------------------
// Server and client plumbing
// ---------------------------------------------------------------------------

export type TestServer = ReturnType<typeof createServer>;

export interface BootOptions {
    interceptors: Interceptor[];
    routes: ReturnType<typeof buildRoutes>;
}

export async function boot(options: BootOptions): Promise<TestServer> {
    const server = createServer({ services: [options.routes], port: 0, allowHTTP1: false, interceptors: options.interceptors, shutdown: { timeout: 1_000 } });
    await server.start();
    return server;
}

export function clientFor(server: TestServer, transport: Transport) {
    if (transport === "http") {
        return createClient(StreamingService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.address?.port}` }));
    }
    return server.localClient(StreamingService);
}

export type StreamingClient = ReturnType<typeof clientFor>;

/** An input stream of `n` items, paced so the call stays open across event loop turns. */
export async function* inputs(value: string, n = STREAM_LENGTH) {
    for (let i = 0; i < n; i++) {
        yield create(ItemSchema, { value, sequence: i });
        await sleep(1);
    }
}

export interface CallResult {
    /** Messages received from the server (server/bidi) or the aggregated count (client). */
    received: number;
    /** Verified identity the caller itself saw around the call: every entry must be the caller's own ambient value. */
    callerViews: Array<string | undefined>;
}

/**
 * One call of the given kind. The loop body runs in the caller's context, so
 * whatever `getAuthContext()` returns there shows whether an iterator operation
 * leaked its identity into the caller.
 */
export async function callOnce(client: StreamingClient, kind: Kind, headers: Record<string, string>, value: string): Promise<CallResult> {
    const callerViews: Array<string | undefined> = [getAuthContext()?.subject];
    const first = create(ItemSchema, { value, sequence: 0 });
    let received = 0;
    switch (kind) {
        case "unary":
            await client.echo(first, { headers });
            received = 1;
            break;
        case "client":
            received = (await client.client(inputs(value), { headers })).total;
            break;
        case "server":
            for await (const _message of client.server(first, { headers })) {
                callerViews.push(getAuthContext()?.subject);
                received++;
                await jitter();
            }
            break;
        case "bidi":
            for await (const _message of client.bidi(inputs(value), { headers })) {
                callerViews.push(getAuthContext()?.subject);
                received++;
                await jitter();
            }
            break;
    }
    callerViews.push(getAuthContext()?.subject);
    return { received, callerViews };
}

// ---------------------------------------------------------------------------
// Concurrent-pairs matrix driver
// ---------------------------------------------------------------------------

export interface Tally {
    scenario: string;
    iterations: number;
    calls: number;
    observations: number;
    own: number;
    lost: number;
    foreign: number;
    ambient: number;
    telemetryMismatch: number;
    callerLeaks: number;
    errors: number;
    missingPhases: number;
    leakAfterCall: number;
}

export interface PairsOptions {
    scenario: string;
    setup: AuthSetup;
    transport: Transport;
    kind: Kind;
    iterations: number;
    /** 2 sends each identity twice in a row: the first call misses a credential cache, the second hits it. */
    callsPerIdentity?: 1 | 2;
    probe: Probe;
    /** Reads the handler observations from somewhere other than `probe`, for handlers running in another process. */
    fetchObservations?: () => Promise<Observation[]>;
    client: StreamingClient;
}

export function identitiesFor(prefix: string, iterations: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < iterations; i++) {
        ids.push(`${prefix}-${i}-A`, `${prefix}-${i}-B`);
    }
    return ids;
}

/**
 * Runs `iterations` pairs of overlapping calls with different verified
 * identities and tallies what every handler phase observed. Telemetry is
 * expected to reach handlers only on the local transports, where the caller's
 * own async scope is the one that drives the iteration.
 */
export async function runConcurrentPairs(options: PairsOptions): Promise<Tally> {
    const { setup, transport, kind, iterations, probe, client } = options;
    const callsPerIdentity = options.callsPerIdentity ?? 1;
    probe.reset();
    let errors = 0;
    let callerLeaks = 0;
    let leakAfterCall = 0;
    const tel = transport !== "http";

    const oneIdentity = async (identity: string) => {
        const headers = await setup.headersFor(identity);
        for (let n = 0; n < callsPerIdentity; n++) {
            const tag = `${identity}#${n}`;
            const call = async () => {
                const result = await callOnce(client, kind, { ...headers, "x-tag": tag }, tag).catch(() => {
                    errors++;
                    return undefined;
                });
                const expectedCaller = transport === "local-ambient" ? AMBIENT_CALLER.subject : undefined;
                for (const view of result?.callerViews ?? []) {
                    if (view !== expectedCaller) {
                        callerLeaks++;
                    }
                }
            };
            const inTelemetry = () => (tel ? telemetryStorage.run(tag, call) : call());
            await (transport === "local-ambient" ? authContextStorage.run(AMBIENT_CALLER, inTelemetry) : inTelemetry());
        }
    };

    for (let i = 0; i < iterations; i++) {
        await Promise.all([oneIdentity(`${options.scenario}-${i}-A`), oneIdentity(`${options.scenario}-${i}-B`)]);
        await nextImmediate();
        if (getAuthContext() !== undefined) {
            leakAfterCall++;
        }
    }

    const observations = options.fetchObservations ? await options.fetchObservations() : probe.observations;
    const tally: Tally = {
        scenario: options.scenario,
        iterations,
        calls: iterations * 2 * callsPerIdentity,
        observations: observations.length,
        own: 0,
        lost: 0,
        foreign: 0,
        ambient: 0,
        telemetryMismatch: 0,
        callerLeaks,
        errors,
        missingPhases: 0,
        leakAfterCall,
    };
    const byTag = new Map<string, Set<string>>();
    for (const o of observations) {
        const identity = o.tag.split("#")[0];
        if (o.seen === identity) {
            tally.own++;
        } else if (o.seen === undefined) {
            tally.lost++;
        } else if (o.seen === AMBIENT_CALLER.subject) {
            tally.ambient++;
        } else {
            tally.foreign++;
        }
        if (tel && o.telemetry !== o.tag) {
            tally.telemetryMismatch++;
        }
        let phases = byTag.get(o.tag);
        if (!phases) {
            phases = new Set();
            byTag.set(o.tag, phases);
        }
        phases.add(o.phase);
    }
    if (byTag.size !== tally.calls) {
        tally.missingPhases += Math.abs(tally.calls - byTag.size) * EXPECTED_PHASES[kind].length;
    }
    for (const phases of byTag.values()) {
        for (const phase of EXPECTED_PHASES[kind]) {
            if (!phases.has(phase)) {
                tally.missingPhases++;
            }
        }
    }
    return tally;
}

/** Field list for `assert.deepStrictEqual`: a clean run has exactly these zeros. */
export function violations(tally: Tally) {
    return {
        errors: tally.errors,
        missingPhases: tally.missingPhases,
        lost: tally.lost,
        foreign: tally.foreign,
        ambient: tally.ambient,
        telemetryMismatch: tally.telemetryMismatch,
        callerLeaks: tally.callerLeaks,
        leakAfterCall: tally.leakAfterCall,
    };
}

export const CLEAN = { errors: 0, missingPhases: 0, lost: 0, foreign: 0, ambient: 0, telemetryMismatch: 0, callerLeaks: 0, leakAfterCall: 0 } as const;

// ---------------------------------------------------------------------------
// Remote JWKS issuer (RS256 and ES256) for the network-verification scenarios
// ---------------------------------------------------------------------------

export const JWKS_ISSUER = "https://issuer.connectum.test";
export const JWKS_AUDIENCE = "streaming-api";

/** The server-side interceptor: verifies tokens against a remote JWKS, pinned to one issuer and audience. */
export function createJwksInterceptor(jwksUri: string): Interceptor {
    return createJwtAuthInterceptor({ jwksUri, issuer: JWKS_ISSUER, audience: JWKS_AUDIENCE, algorithms: ["RS256", "ES256"] });
}

export interface JwksIssuer {
    jwksUri: string;
    /** Mints a signed token for `sub`; issuer and audience can be overridden to produce rejected tokens. */
    mint(sub: string, options?: { alg?: "RS256" | "ES256"; issuer?: string; audience?: string; expiresIn?: string }): Promise<string>;
    /** An RS256 token signed by a key the JWKS does not publish. */
    mintWithUnknownKey(sub: string): Promise<string>;
    close(): Promise<void>;
}

/** Starts a loopback JWKS server publishing one RS256 and one ES256 key and returns a token minter for them. */
export async function startJwksIssuer(): Promise<JwksIssuer> {
    const keys = {
        RS256: await generateKeyPair("RS256", { extractable: true }),
        ES256: await generateKeyPair("ES256", { extractable: true }),
    };
    const published = await Promise.all((["RS256", "ES256"] as const).map(async (alg) => ({ ...(await exportJWK(keys[alg].publicKey)), kid: `kid-${alg}`, alg, use: "sig" })));
    const jwks = await startTestJwksServer(published);

    const sign = async (privateKey: CryptoKey, alg: string, kid: string, sub: string, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) =>
        await new SignJWT({})
            .setProtectedHeader({ alg, kid })
            .setSubject(sub)
            .setIssuedAt()
            .setIssuer(options.issuer ?? JWKS_ISSUER)
            .setAudience(options.audience ?? JWKS_AUDIENCE)
            .setExpirationTime(options.expiresIn ?? "1h")
            .sign(privateKey);

    return {
        jwksUri: jwks.url,
        mint: (sub, options = {}) => {
            const alg = options.alg ?? "RS256";
            return sign(keys[alg].privateKey, alg, `kid-${alg}`, sub, options);
        },
        mintWithUnknownKey: async (sub) => {
            const stranger = await generateKeyPair("RS256", { extractable: true });
            return await sign(stranger.privateKey, "RS256", "kid-RS256", sub);
        },
        close: () => jwks.close(),
    };
}

/** An {@link AuthSetup} backed by a {@link JwksIssuer}; tokens alternate algorithm by identity so both are exercised. */
export function createJwksAuthSetup(issuer: JwksIssuer): AuthSetup {
    return {
        name: "jwt-jwks",
        interceptor: createJwksInterceptor(issuer.jwksUri),
        headersFor: async (identity) => ({ authorization: `Bearer ${await issuer.mint(identity, { alg: identity.endsWith("A") ? "RS256" : "ES256" })}` }),
        verifications: () => 0,
    };
}

// ---------------------------------------------------------------------------
// Never-ending handlers for the cancellation scenarios
// ---------------------------------------------------------------------------

/**
 * How an endless handler spends time between messages.
 * - `yield-only`: it produces the next message as soon as it is pulled, so a stalled consumer leaves it parked at `yield`.
 * - `slow-await`: it awaits a timer that ignores the call's signal before every message, so an abort lands while a pull is pending.
 */
export type Pace = "yield-only" | "slow-await";

export const SLOW_AWAIT_MS = 120;

/** Handlers that never finish on their own and report each cleanup together with the identity visible in `finally`. */
export function buildEndlessRoutes(probe: Probe, pace: Pace) {
    const between = async () => {
        // A pull-driven consumer sets the pace over the in-process transport, but over HTTP/2 the server pumps
        // an endless generator into the socket as fast as it can; a short pause keeps that from starving the
        // event loop (and with it the call's own deadline timers) while still leaving the handler parked at
        // `yield` whenever the consumer stops pulling.
        await sleep(pace === "slow-await" ? SLOW_AWAIT_MS : 2);
    };
    return defineService(StreamingService, {
        echo: async (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
        client: async () => create(CountSchema, { total: 0 }),
        server: async function* (_req, ctx) {
            const tag = tagOf(ctx);
            probe.record(tag, "server-start");
            try {
                for (let i = 0; ; i++) {
                    await between();
                    yield create(ItemSchema, { value: tag, sequence: i });
                    probe.record(tag, `server-after-yield-${i}`);
                }
            } finally {
                probe.record(tag, "server-finally");
                probe.cleanup(tag);
            }
        },
        bidi: async function* (requests, ctx) {
            const tag = tagOf(ctx);
            probe.record(tag, "bidi-start");
            try {
                let i = 0;
                for await (const _message of requests) {
                    await between();
                    yield create(ItemSchema, { value: tag, sequence: i });
                    probe.record(tag, `bidi-after-yield-${i}`);
                    i++;
                }
            } finally {
                probe.record(tag, "bidi-finally");
                probe.cleanup(tag);
            }
        },
    });
}

/** An input stream that keeps producing until the call goes away. */
export async function* endlessInputs(value: string) {
    for (let i = 0; ; i++) {
        yield create(ItemSchema, { value, sequence: i });
        await sleep(5);
    }
}

/** Polls `predicate` until it holds or `timeoutMs` passes; returns whether it held. */
export async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await sleep(10);
    }
    return predicate();
}
