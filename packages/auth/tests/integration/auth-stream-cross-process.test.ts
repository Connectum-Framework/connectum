/**
 * The verified identity survives the whole life of a streaming call when the
 * server is a different process than the client.
 *
 * Here nothing is shared between the two sides but the socket: the token is
 * minted in this process, signed with RS256 or ES256, and the server process
 * verifies it against a JWKS endpoint it fetches over HTTP. The handler's view
 * of the identity is read back from the server process, so the assertion is
 * about what the handler really saw, not about what this process believes.
 */

import assert from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ItemSchema } from "../fixtures/streaming/v1/streaming_pb.ts";
import type { RemoteReply, RemoteRequest } from "../helpers/remote-server.ts";
import {
    type AuthFactoryName,
    type AuthSetup,
    CLEAN,
    callOnce,
    createAuthSetup,
    createJwksAuthSetup,
    endlessInputs,
    identitiesFor,
    type JwksIssuer,
    type Kind,
    type Observation,
    type Pace,
    runConcurrentPairs,
    StreamingService,
    startJwksIssuer,
    type Transport,
    violations,
} from "../helpers/stream-context.ts";

const PAIRS = Number(process.env.AUTH_STREAM_PAIRS ?? 250);
const KINDS: readonly Kind[] = ["unary", "client", "server", "bidi"];
const SERVER_SCRIPT = fileURLToPath(new URL("../helpers/remote-server.ts", import.meta.url));

interface Remote {
    pid: number;
    port: number;
    dump(identities?: string[]): Promise<Extract<RemoteReply, { type: "dump" }>>;
    reset(): void;
    stop(): Promise<void>;
}

const children: ChildProcess[] = [];
const issuers: JwksIssuer[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
    }
    for (const issuer of issuers.splice(0)) {
        await issuer.close();
    }
});

async function startRemote(options: { factory: AuthFactoryName | "jwt-jwks"; routes: "finite" | Pace; jwksUri?: string; identities?: string[] }): Promise<Remote> {
    const child = spawn(process.execPath, [SERVER_SCRIPT], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child);
    const waiting: Array<(reply: RemoteReply) => void> = [];
    child.on("message", (reply: RemoteReply) => waiting.shift()?.(reply));
    const exchange = (request: RemoteRequest) =>
        new Promise<RemoteReply>((resolve, reject) => {
            const failed = () => reject(new Error("server process exited before replying"));
            child.once("exit", failed);
            waiting.push((reply) => {
                child.off("exit", failed);
                resolve(reply);
            });
            child.send(request);
        });

    const ready = await exchange({ type: "start", factory: options.factory, routes: options.routes, ...(options.jwksUri ? { jwksUri: options.jwksUri } : {}), identities: options.identities ?? [] });
    assert.strictEqual(ready.type, "ready");
    return {
        pid: ready.pid,
        port: ready.port,
        async dump(identities = []) {
            const reply = await exchange({ type: "dump", identities });
            assert.strictEqual(reply.type, "dump");
            return reply;
        },
        reset() {
            child.send({ type: "reset" } satisfies RemoteRequest);
        },
        async stop() {
            await exchange({ type: "stop" });
        },
    };
}

function networkClient(port: number) {
    return createClient(StreamingService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
}

describe("server in its own process, RS256/ES256 tokens verified through a remote JWKS", () => {
    for (const kind of KINDS) {
        it(`${kind}: the handler sees only its own verified identity at every phase (${PAIRS} overlapping pairs)`, async () => {
            const issuer = await startJwksIssuer();
            issuers.push(issuer);
            const remote = await startRemote({ factory: "jwt-jwks", routes: "finite", jwksUri: issuer.jwksUri });
            assert.notStrictEqual(remote.pid, process.pid, "the server must be another process");

            const setup = createJwksAuthSetup(issuer);
            const tally = await runConcurrentPairs({
                scenario: `xproc/${kind}`,
                setup,
                transport: "http" satisfies Transport,
                kind,
                iterations: PAIRS,
                probe: { observations: [], cleanups: new Map(), record() {}, cleanup() {}, reset: () => remote.reset() },
                client: networkClient(remote.port),
                fetchObservations: async () => (await remote.dump()).observations as Observation[],
            });
            assert.deepStrictEqual(violations(tally), CLEAN, JSON.stringify(tally));
            assert.ok(tally.own > 0);
            await remote.stop();
        });
    }

    it("a missing, mis-issued, mis-targeted, foreign-key or expired token is rejected before any handler runs", async () => {
        const issuer = await startJwksIssuer();
        issuers.push(issuer);
        const remote = await startRemote({ factory: "jwt-jwks", routes: "finite", jwksUri: issuer.jwksUri });
        const client = networkClient(remote.port);
        const tokens: Record<string, string | undefined> = {
            missing: undefined,
            "wrong issuer": await issuer.mint("mallory", { issuer: "https://other-issuer.example" }),
            "wrong audience": await issuer.mint("mallory", { audience: "another-api" }),
            "unknown key": await issuer.mintWithUnknownKey("mallory"),
            expired: await issuer.mint("mallory", { expiresIn: "-1m" }),
            "valid ES256 control": await issuer.mint("control", { alg: "ES256" }),
        };
        for (const [label, token] of Object.entries(tokens)) {
            for (const kind of KINDS) {
                const outcome = await callOnce(client, kind, { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-tag": `${label}#${kind}` }, `${label}#${kind}`).then(
                    () => "accepted",
                    (error) => Code[ConnectError.from(error).code],
                );
                assert.strictEqual(outcome, label === "valid ES256 control" ? "accepted" : "Unauthenticated", `${label} / ${kind}`);
            }
        }
        const { observations } = await remote.dump();
        assert.deepStrictEqual(
            [...new Set(observations.map((o) => o.tag.split("#")[0]))],
            ["valid ES256 control"],
            "only the valid token ever reached a handler",
        );
        assert.ok(observations.every((o) => o.seen === "control"));
        await remote.stop();
    });

    for (const factory of ["generic-cache", "session-cache"] as const) {
        it(`${factory}: a real cache miss and then a hit, for every call kind`, async () => {
            const identities = identitiesFor(`xproc-${factory}`, 40);
            const remote = await startRemote({ factory, routes: "finite", identities });
            const setup: AuthSetup = createAuthSetup(factory, identities);
            const client = networkClient(remote.port);
            const verifiedAfterFirst: number[] = [];
            const verifiedAfterSecond: number[] = [];
            const identity = identities[0] as string;
            for (const kind of KINDS) {
                const own = `${identity}-${kind}`;
                const headers = { ...(await setup.headersFor(own)), "x-tag": `${own}#0` };
                await callOnce(client, kind, headers, `${own}#0`);
                verifiedAfterFirst.push((await remote.dump([own])).verifications[own] as number);
                await callOnce(client, kind, { ...headers, "x-tag": `${own}#1` }, `${own}#1`);
                verifiedAfterSecond.push((await remote.dump([own])).verifications[own] as number);
            }
            assert.deepStrictEqual(verifiedAfterFirst, [1, 1, 1, 1], "the first call of each identity is a miss and verifies once");
            assert.deepStrictEqual(verifiedAfterSecond, [1, 1, 1, 1], "the second call is served from the cache without verifying again");
            const { observations } = await remote.dump();
            assert.ok(observations.length > 0);
            for (const o of observations) {
                assert.strictEqual(o.seen, o.tag.split("#")[0], `${o.tag} / ${o.phase}`);
            }
            await remote.stop();
        });
    }

    for (const pace of ["yield-only", "slow-await"] as const) {
        for (const kind of ["server", "bidi"] as const) {
            it(`${kind} (${pace}): a client abort and a deadline are cleaned up once in the server process, under the call's identity`, async () => {
                const issuer = await startJwksIssuer();
                issuers.push(issuer);
                const remote = await startRemote({ factory: "jwt-jwks", routes: pace, jwksUri: issuer.jwksUri });
                const client = networkClient(remote.port);
                const setup = createJwksAuthSetup(issuer);
                const tags: string[] = [];

                const end = async (identity: string, how: "abort" | "deadline") => {
                    const tag = `${identity}#${how}`;
                    tags.push(tag);
                    const headers = { ...(await setup.headersFor(identity)), "x-tag": tag };
                    const abort = new AbortController();
                    const options = how === "abort" ? { headers, signal: abort.signal } : { headers, timeoutMs: 1_000 };
                    const first = create(ItemSchema, { value: tag });
                    const iterator = (kind === "server" ? client.server(first, options) : client.bidi(endlessInputs(tag), options))[Symbol.asyncIterator]();
                    await iterator.next();
                    const pending = pace === "slow-await" && how === "abort" ? iterator.next() : undefined;
                    if (how === "abort") {
                        await sleep(pace === "slow-await" ? 30 : 10);
                        abort.abort();
                    } else {
                        await sleep(1_100);
                    }
                    await (pending ?? iterator.next()).then(
                        () => assert.fail("the ended call must not deliver more messages"),
                        (error) => assert.ok([Code.Canceled, Code.DeadlineExceeded].includes(ConnectError.from(error).code)),
                    );
                };

                for (let round = 0; round < 10; round++) {
                    await Promise.all([end(`xproc-${pace}-${kind}-${round}-A`, "abort"), end(`xproc-${pace}-${kind}-${round}-B`, "deadline")]);
                }
                let dump = await remote.dump();
                for (let attempt = 0; attempt < 100 && !tags.every((tag) => dump.cleanups.some(([cleaned]) => cleaned === tag)); attempt++) {
                    await sleep(50);
                    dump = await remote.dump();
                }
                await sleep(100);
                dump = await remote.dump();

                const byTag = new Map(dump.cleanups);
                assert.deepStrictEqual(
                    tags.filter((tag) => byTag.get(tag)?.count !== 1),
                    [],
                    "every ended call is cleaned up exactly once",
                );
                assert.deepStrictEqual(
                    tags.filter((tag) => byTag.get(tag)?.seen !== tag.split("#")[0]),
                    [],
                    "the cleanup ran under the identity of its own call",
                );
                assert.ok(dump.observations.every((o) => o.seen === o.tag.split("#")[0]));
                await remote.stop();
            });
        }
    }
});
