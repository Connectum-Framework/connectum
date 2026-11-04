/**
 * The fallback interceptor next to retry and the circuit breaker, over real transports.
 *
 * A reader who enables all three expects the retries to run before the fallback value is
 * served, and the breaker to open on repeated failures behind the fallback. That needs the
 * fallback to stand outside both: an error reaches it only after the retries are exhausted
 * or the breaker has refused the call. A fallback inside them swallows the first failure, so
 * the handler is called once and the breaker never sees a failure.
 *
 * Oracle: how many times the failing handler ran, and what the caller received, for a real
 * `createServer` on h2c port 0 with the shipped `createDefaultInterceptors` chain.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import type { DefaultInterceptorOptions } from "../../src/defaults.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";

const FALLBACK_MESSAGE = "FALLBACK-VALUE";
const retry = { maxRetries: 3, initialDelay: 1, maxDelay: 2 };

interface Probe {
    /** Calls that reached the application handler. */
    attempts: number;
    /** Calls the fallback handler was asked to answer. */
    fallbackCalls: number;
}

type Outcome = { ok: string } | { code: Code; text: string };

/**
 * Starts a server whose `echo` fails with Unavailable for the first `failures` calls and
 * succeeds afterwards, runs `body` with a client per transport, and stops the server.
 */
async function withServer(options: { chain: DefaultInterceptorOptions; failures: number; withFallback: boolean }, body: (clients: Record<string, Client<typeof EchoService>>, probe: Probe) => Promise<void>): Promise<void> {
    const probe: Probe = { attempts: 0, fallbackCalls: 0 };
    const failFirst = (): never => {
        throw new ConnectError("down", Code.Unavailable);
    };
    const server: Server = createServer({
        services: [
            defineService(EchoService, {
                echo: (req) => {
                    probe.attempts++;
                    if (probe.attempts <= options.failures) {
                        failFirst();
                    }
                    return create(EchoResponseSchema, { message: `served:${req.message}` });
                },
                secureEcho: () => failFirst(),
                rateLimitedEcho: () => failFirst(),
            }),
        ],
        interceptors: createDefaultInterceptors({
            errorHandler: { logErrors: false },
            ...options.chain,
            ...(options.withFallback
                ? {
                      fallback: {
                          handler: () => {
                              probe.fallbackCalls++;
                              return create(EchoResponseSchema, { message: FALLBACK_MESSAGE });
                          },
                      },
                  }
                : {}),
        }),
        port: 0,
        allowHTTP1: false,
    });
    await server.start();
    try {
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const baseUrl = `http://localhost:${port}`;
        await body(
            {
                grpc: createClient(EchoService, createGrpcTransport({ baseUrl })),
                connect: createClient(EchoService, createConnectTransport({ baseUrl, httpVersion: "2" })),
                local: server.localClient(EchoService),
            },
            probe,
        );
    } finally {
        await server.stop();
    }
}

async function call(client: Client<typeof EchoService>): Promise<Outcome> {
    return await client.echo(create(EchoRequestSchema, { message: "x" })).then(
        (res): Outcome => ({ ok: res.message }),
        (err: unknown): Outcome => {
            const e = ConnectError.from(err);
            return { code: e.code, text: e.rawMessage };
        },
    );
}

describe("fallback together with retry and the circuit breaker", () => {
    for (const transport of ["grpc", "connect", "local"]) {
        it(`${transport}: retry alone exhausts its attempts and the caller gets the failure`, async () => {
            await withServer({ chain: { retry }, failures: Number.POSITIVE_INFINITY, withFallback: false }, async (clients, probe) => {
                assert.deepStrictEqual(await call(clients[transport]!), { code: Code.Unavailable, text: "down" });
                assert.strictEqual(probe.attempts, 4, "the first attempt and three retries");
            });
        });

        it(`${transport}: with a fallback the handler is retried first, then the fallback value is served`, async () => {
            await withServer({ chain: { retry }, failures: Number.POSITIVE_INFINITY, withFallback: true }, async (clients, probe) => {
                assert.deepStrictEqual(await call(clients[transport]!), { ok: FALLBACK_MESSAGE });
                assert.strictEqual(probe.attempts, 4, "the first attempt and three retries must run before the fallback");
                assert.strictEqual(probe.fallbackCalls, 1, "the fallback answers once, after the retries are exhausted");
            });
        });

        it(`${transport}: a retry that succeeds is served and the fallback is not asked`, async () => {
            await withServer({ chain: { retry }, failures: 2, withFallback: true }, async (clients, probe) => {
                assert.deepStrictEqual(await call(clients[transport]!), { ok: "served:x" });
                assert.strictEqual(probe.attempts, 3);
                assert.strictEqual(probe.fallbackCalls, 0, "the fallback must not be called when a retry succeeds");
            });
        });

        it(`${transport}: the circuit breaker alone opens after the threshold`, async () => {
            await withServer({ chain: { circuitBreaker: { threshold: 2, halfOpenAfter: 60_000 } }, failures: Number.POSITIVE_INFINITY, withFallback: false }, async (clients, probe) => {
                const results = [];
                for (let i = 0; i < 4; i++) {
                    results.push(await call(clients[transport]!));
                }
                assert.deepStrictEqual(results, [
                    { code: Code.Unavailable, text: "down" },
                    { code: Code.Unavailable, text: "down" },
                    { code: Code.Unavailable, text: "Circuit breaker is open (2 consecutive failures)" },
                    { code: Code.Unavailable, text: "Circuit breaker is open (2 consecutive failures)" },
                ]);
                assert.strictEqual(probe.attempts, 2);
            });
        });

        it(`${transport}: with a fallback the breaker still opens, and the fallback answers while it is open`, async () => {
            await withServer({ chain: { circuitBreaker: { threshold: 2, halfOpenAfter: 60_000 } }, failures: Number.POSITIVE_INFINITY, withFallback: true }, async (clients, probe) => {
                const results = [];
                for (let i = 0; i < 4; i++) {
                    results.push(await call(clients[transport]!));
                }
                assert.deepStrictEqual(results, [{ ok: FALLBACK_MESSAGE }, { ok: FALLBACK_MESSAGE }, { ok: FALLBACK_MESSAGE }, { ok: FALLBACK_MESSAGE }]);
                assert.strictEqual(probe.attempts, 2, "the third and fourth calls must not reach the handler: the breaker is open");
                assert.strictEqual(probe.fallbackCalls, 4, "the fallback answers the two failures and the two refusals of the open breaker");
            });
        });
    }
});
