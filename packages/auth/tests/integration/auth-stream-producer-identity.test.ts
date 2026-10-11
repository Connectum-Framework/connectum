/**
 * The caller's request generator never observes the identity verified for the
 * call it feeds.
 *
 * In-process, the handler of a client-streaming or bidirectional call pulls
 * the caller's generator from inside its own code, which runs under the
 * identity the authentication interceptor verified for that call. The
 * generator belongs to the caller, so every one of its steps (before a yield,
 * after an await, in finally) must see the caller's own ambient identity, or
 * none, exactly as over HTTP where the client transport pumps the generator.
 * A caller that holds identity A and calls a local service with a service
 * credential S must never see S from its own code.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { createServer, defineService } from "@connectum/core";
import { authContextStorage, getAuthContext } from "../../src/context.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";
import { AMBIENT_CALLER, clientFor, createAuthSetup, type Transport } from "../helpers/stream-context.ts";

const PAIRS = Number(process.env.PRODUCER_IDENTITY_PAIRS ?? 10);
const MESSAGES = 3;

const routes = defineService(StreamingService, {
    echo: async (req) => create(ItemSchema, { value: req.value }),
    client: async (requests) => {
        let total = 0;
        for await (const _item of requests) {
            total++;
            await sleep(1);
        }
        return { total };
    },
    server: async function* (req) {
        yield create(ItemSchema, { value: req.value });
    },
    bidi: async function* (requests) {
        for await (const item of requests) {
            await sleep(1);
            yield create(ItemSchema, { value: item.value, sequence: item.sequence });
        }
    },
});

const started: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

async function* producer(tag: string, seen: Array<string | undefined>) {
    try {
        for (let i = 0; i < MESSAGES; i++) {
            seen.push(getAuthContext()?.subject);
            yield create(ItemSchema, { value: tag, sequence: i });
            await sleep(1);
            seen.push(getAuthContext()?.subject);
        }
    } finally {
        seen.push(getAuthContext()?.subject);
    }
}

for (const transport of ["local", "local-ambient", "http"] as const satisfies readonly Transport[]) {
    for (const kind of ["client", "bidi"] as const) {
        describe(`${transport} ${kind}: identity seen by the request producer`, () => {
            it(`is the caller's own at every step, for ${PAIRS} overlapping pairs`, { timeout: 60_000 }, async () => {
                const identities: string[] = [];
                for (let i = 0; i < PAIRS; i++) {
                    identities.push(`${kind}-${i}-A`, `${kind}-${i}-B`);
                }
                const setup = createAuthSetup("generic", identities);
                const server = createServer({ services: [routes], port: 0, allowHTTP1: false, interceptors: [setup.interceptor], shutdown: { timeout: 1_000 } });
                started.push(server);
                await server.start();
                const client = clientFor(server, transport);
                const expected = transport === "local-ambient" ? AMBIENT_CALLER.subject : undefined;

                const violations: string[] = [];
                let steps = 0;
                const call = async (identity: string) => {
                    const seen: Array<string | undefined> = [];
                    const headers = await setup.headersFor(identity);
                    const run = async () => {
                        if (kind === "client") {
                            const count = await client.client(producer(identity, seen), { headers });
                            assert.strictEqual(count.total, MESSAGES);
                        } else {
                            let received = 0;
                            for await (const _item of client.bidi(producer(identity, seen), { headers })) {
                                received++;
                            }
                            assert.strictEqual(received, MESSAGES);
                        }
                        assert.strictEqual(getAuthContext()?.subject, expected, "the caller keeps its own identity after the call");
                    };
                    await (transport === "local-ambient" ? authContextStorage.run(AMBIENT_CALLER, run) : run());
                    assert.strictEqual(seen.length, MESSAGES * 2 + 1, "every producer phase ran");
                    for (const subject of seen) {
                        steps++;
                        if (subject !== expected) {
                            violations.push(`${identity}: producer saw ${String(subject)} instead of ${String(expected)}`);
                        }
                    }
                };

                for (let i = 0; i < PAIRS; i++) {
                    await Promise.all([call(`${kind}-${i}-A`), call(`${kind}-${i}-B`)]);
                }
                assert.strictEqual(steps, PAIRS * 2 * (MESSAGES * 2 + 1));
                assert.deepStrictEqual(violations, [], `${violations.length} of ${steps} producer steps saw the server's verified identity`);
            });
        });
    }
}
