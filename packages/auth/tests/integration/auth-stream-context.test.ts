/**
 * The verified identity must stay available to the handler of every call kind
 * for as long as the call lives, not only while the interceptor chain is being
 * entered.
 *
 * A server-streaming or bidi handler is a generator: Connect gets the response
 * iterable back from the chain and advances it later, after the authentication
 * interceptor has returned. These tests run a real `createServer()` behind each
 * authentication factory that establishes an identity and observe, from inside
 * the handler, which identity is visible before and after every await and
 * yield and inside `finally`, with two different identities in flight at once
 * and with a different identity already held by the caller of a local call.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import {
    AUTH_FACTORY_NAMES,
    type AuthFactoryName,
    type AuthSetup,
    boot,
    buildRoutes,
    CLEAN,
    callOnce,
    clientFor,
    createAuthSetup,
    createJwksAuthSetup,
    createProbe,
    identitiesFor,
    type Kind,
    runConcurrentPairs,
    startJwksIssuer,
    type TestServer,
    type Transport,
    violations,
} from "../helpers/stream-context.ts";

/** At least 250 overlapping pairs per scenario: a lost or crossed identity shows up as a count, not as a flake. */
const PAIRS = Number(process.env.AUTH_STREAM_PAIRS ?? 250);

const KINDS: readonly Kind[] = ["unary", "client", "server", "bidi"];
const TRANSPORTS: readonly Transport[] = ["local", "local-ambient", "http"];
const CACHE_FACTORIES: readonly AuthFactoryName[] = ["generic-cache", "session-cache"];

const started: TestServer[] = [];

afterEach(async () => {
    for (const server of started.splice(0)) {
        if (server.isRunning) {
            await server.stop();
        }
    }
});

async function runScenario(factory: AuthFactoryName | "jwt-jwks", transport: Transport, kind: Kind) {
    const scenario = `${factory}/${transport}/${kind}`;
    const probe = createProbe();
    const issuer = factory === "jwt-jwks" ? await startJwksIssuer() : undefined;
    try {
        const setup: AuthSetup = issuer ? createJwksAuthSetup(issuer) : createAuthSetup(factory as AuthFactoryName, identitiesFor(scenario, PAIRS));
        const server = await boot({ interceptors: [setup.interceptor], routes: buildRoutes(probe) });
        started.push(server);
        const client = clientFor(server, transport);
        const callsPerIdentity = factory.endsWith("-cache") ? 2 : 1;
        const tally = await runConcurrentPairs({ scenario, setup, transport, kind, iterations: PAIRS, callsPerIdentity, probe, client });
        return { tally, setup, probe };
    } finally {
        await issuer?.close();
    }
}

for (const factory of [...AUTH_FACTORY_NAMES, "jwt-jwks"] as const) {
    for (const transport of TRANSPORTS) {
        for (const kind of KINDS) {
            describe(`${factory} over ${transport}: ${kind}`, () => {
                it(`handler sees only its own verified identity at every phase (${PAIRS} overlapping pairs)`, async () => {
                    const { tally, setup } = await runScenario(factory, transport, kind);
                    assert.deepStrictEqual(violations(tally), CLEAN, `observations: ${JSON.stringify(tally)}`);
                    assert.ok(tally.own > 0, "no handler observation was recorded");
                    if (CACHE_FACTORIES.includes(factory as AuthFactoryName)) {
                        // The second call of every identity must have been served from the credential cache, not verified again.
                        for (const identity of identitiesFor(`${factory}/${transport}/${kind}`, PAIRS)) {
                            assert.strictEqual(setup.verifications(identity), 1, `${identity} must be verified once and then served from the cache`);
                        }
                    }
                });
            });
        }
    }
}

describe("rejected credentials never reach a handler", () => {
    async function rejectedOver(transport: Transport, setup: AuthSetup, headers: Record<string, string>) {
        const probe = createProbe();
        const server = await boot({ interceptors: [setup.interceptor], routes: buildRoutes(probe) });
        started.push(server);
        const client = clientFor(server, transport);
        const failures: Array<Code | undefined> = [];
        for (const kind of KINDS) {
            try {
                await callOnce(client, kind, { ...headers, "x-tag": `rejected-${kind}` }, `rejected-${kind}`);
                failures.push(undefined);
            } catch (error) {
                failures.push(ConnectError.from(error).code);
            }
        }
        return { failures, entered: probe.observations.length };
    }

    for (const transport of ["local", "http"] as const) {
        it(`missing credentials are Unauthenticated before the handler over ${transport}`, async () => {
            const result = await rejectedOver(transport, createAuthSetup("jwt-secret", []), {});
            assert.deepStrictEqual(result.failures, KINDS.map(() => Code.Unauthenticated));
            assert.strictEqual(result.entered, 0);
        });

        it(`a token from the wrong issuer, wrong audience, an unknown key or an expired token is Unauthenticated over ${transport}`, async () => {
            const issuer = await startJwksIssuer();
            try {
                const setup = createJwksAuthSetup(issuer);
                const bad = {
                    "wrong issuer": await issuer.mint("mallory", { issuer: "https://other-issuer.example" }),
                    "wrong audience": await issuer.mint("mallory", { audience: "another-api" }),
                    "unknown key": await issuer.mintWithUnknownKey("mallory"),
                    expired: await issuer.mint("mallory", { expiresIn: "-1m" }),
                };
                for (const [label, token] of Object.entries(bad)) {
                    const result = await rejectedOver(transport, setup, { authorization: `Bearer ${token}` });
                    assert.deepStrictEqual(
                        result.failures,
                        KINDS.map(() => Code.Unauthenticated),
                        label,
                    );
                    assert.strictEqual(result.entered, 0, `${label}: the handler must not run`);
                }
            } finally {
                await issuer.close();
            }
        });
    }

    it("an untrusted gateway marker and an unknown mesh principal are Unauthenticated before the handler", async () => {
        const gateway = await rejectedOver("local", createAuthSetup("gateway", []), { "x-gateway-secret": "forged", "x-user-id": "mallory" });
        assert.deepStrictEqual(gateway.failures, KINDS.map(() => Code.Unauthenticated));
        assert.strictEqual(gateway.entered, 0);

        const internal = await rejectedOver("local", createAuthSetup("internal", ["trusted-peer"]), { "x-forwarded-client-principal": "intruder" });
        assert.deepStrictEqual(internal.failures, KINDS.map(() => Code.Unauthenticated));
        assert.strictEqual(internal.entered, 0);
    });

    it("a rejected streaming call does not leave an identity behind for the next call", async () => {
        const probe = createProbe();
        const setup = createAuthSetup("generic", []);
        const server = await boot({ interceptors: [setup.interceptor], routes: buildRoutes(probe) });
        started.push(server);
        const client = clientFor(server, "local");
        await assert.rejects(callOnce(client, "server", { "x-tag": "anonymous#0" }, "anonymous#0"));
        await callOnce(client, "server", { ...(await setup.headersFor("alice")), "x-tag": "alice#0" }, "alice#0");
        const seen = new Set(probe.observations.map((o) => o.seen));
        assert.deepStrictEqual([...seen], ["alice"]);
        // The unauthenticated call produced nothing at all.
        assert.ok(probe.observations.every((o) => o.tag === "alice#0"));
    });
});
