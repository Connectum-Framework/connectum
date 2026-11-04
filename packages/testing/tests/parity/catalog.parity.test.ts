/**
 * Cross-transport parity of catalog-routed calls (`ctx.call` / `ctx.stream`)
 * on a catalog that `buf generate` and `protoc-gen-connectum-catalog` produce
 * from `tests/fixtures/catalog/proto`.
 *
 * The same call reaches the server under test over HTTP/2 and over the
 * in-process transport, and the handler it reaches calls on through the
 * catalog. Three topologies decide where that onward call goes:
 *
 * - local to local: the called service is mounted on the same server, so the
 *   call is dispatched in-process;
 * - local to remote: the called service runs on another server, reached over
 *   HTTP/2 through the `remoteResolver`;
 * - remote to remote: the handler is itself reached remotely and calls a
 *   service that calls a third server over HTTP/2, so the call crosses two
 *   remote hops.
 *
 * What a call must answer is the contract in the proto comments and the
 * service-catalog reference (a `Code.NotFound` of the callee propagates to the
 * caller unchanged; a resolver that has no route answers `Unavailable`; an
 * unknown service or method is `Unimplemented`), written out below as
 * literals. Each scenario checks both transports against them and then against
 * each other, so neither transport can be wrong in the same way as the other.
 */

import assert from "node:assert/strict";
import { after, before, describe } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer, type RemoteResolver, type Server, type ServiceDefinition } from "@connectum/core";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { serviceCatalog } from "../fixtures/catalog/pb/catalog.gen.ts";
import { EdgeService, type Item, ItemSchema, ProbeService, RelayService } from "../fixtures/catalog/pb/catalogparity/v1/parity_pb.ts";
import { edgeService, type LeafProbeHolder, newLeafProbe, probeService, relayService, targetService } from "../fixtures/catalog/services.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

/** How long a scenario waits for something that must happen before it reports that it did not. */
const WAIT_MS = 3000;

const probe: LeafProbeHolder = { current: newLeafProbe() };

interface Upstream {
    transport: Transport;
    server: Server;
}

async function startUpstream(services: ServiceDefinition[], remoteResolver?: RemoteResolver): Promise<Upstream> {
    const server = createServer({
        services,
        catalog: serviceCatalog,
        ...(remoteResolver !== undefined ? { remoteResolver } : {}),
        port: 0,
        allowHTTP1: false,
        readMaxBytes: 1 << 20,
    });
    await server.start();
    const port = server.address?.port;
    assert.ok(port, "the upstream server must bind a port");
    return { server, transport: createGrpcTransport({ baseUrl: `http://localhost:${port}` }) };
}

async function stopUpstream(upstream: Upstream | undefined): Promise<void> {
    if (upstream?.server.isRunning) {
        await upstream.server.stop();
    }
}

/** A resolver that serves the listed services from the given transport and has no route for any other. */
function routeTo(transport: () => Transport | undefined, typeNames: readonly string[]): RemoteResolver {
    return ({ typeName }) => (typeNames.includes(typeName) ? (transport() ?? null) : null);
}

/** `true` if `settlement` settles within `WAIT_MS`. */
async function happensWithin(settlement: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            settlement.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), WAIT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

type Plain = { value: string; sequence: number };

function plain(item: Item): Plain {
    return { value: item.value, sequence: item.sequence };
}

function failure(error: unknown): NonNullable<ParityScenarioResult["error"]> {
    assert.ok(error instanceof ConnectError, `expected a ConnectError, got ${String(error)}`);
    return { code: error.code, message: error.rawMessage };
}

async function* sending(items: readonly Parameters<typeof create<typeof ItemSchema>>[1][]): AsyncGenerator<Item> {
    for (const init of items) {
        yield create(ItemSchema, init);
    }
}

/** The four methods of the entry service, whichever of `RelayService` and `EdgeService` it is. */
function entryClient(transport: Transport, entry: "relay" | "edge") {
    if (entry === "relay") {
        const client = createClient(RelayService, transport);
        return { echo: client.echo.bind(client), count: client.count.bind(client), sum: client.sum.bind(client), chat: client.chat.bind(client) };
    }
    const client = createClient(EdgeService, transport);
    return { echo: client.echo.bind(client), count: client.count.bind(client), sum: client.sum.bind(client), chat: client.chat.bind(client) };
}

/** Both transports must produce `expected` (a literal from the contract); the diff of the two follows. */
function expecting(expected: ParityScenarioResult) {
    return (http: ParityScenarioResult, local: ParityScenarioResult) => {
        assert.deepStrictEqual(http, expected, "HTTP must satisfy the contract, not merely agree with local");
        assert.deepStrictEqual(local, expected, "local must satisfy the contract, not merely agree with HTTP");
        defaultCompare(http, local);
    };
}

// ── Topologies ────────────────────────────────────────────────────────────

interface Topology {
    name: string;
    entry: "relay" | "edge";
    /** What the entry service puts in front of the value the leaf answers. */
    prefix: string;
    /** Called before the tests of the topology. */
    start(): Promise<void>;
    stop(): Promise<void>;
    services(): ServiceDefinition[];
    resolver(): RemoteResolver;
}

function localToLocal(): Topology {
    return {
        name: "local to local",
        entry: "relay",
        prefix: "relay:",
        start: async () => {},
        stop: async () => {},
        services: () => [relayService(), targetService(probe)],
        resolver: () => () => null,
    };
}

function localToRemote(): Topology {
    let leaf: Upstream | undefined;
    return {
        name: "local to remote",
        entry: "relay",
        prefix: "relay:",
        start: async () => {
            leaf = await startUpstream([targetService(probe)]);
        },
        stop: () => stopUpstream(leaf),
        services: () => [relayService()],
        resolver: () => routeTo(() => leaf?.transport, ["catalogparity.v1.TargetService"]),
    };
}

function remoteToRemote(): Topology {
    let leaf: Upstream | undefined;
    let middle: Upstream | undefined;
    return {
        name: "remote to remote",
        entry: "edge",
        prefix: "edge:relay:",
        start: async () => {
            leaf = await startUpstream([targetService(probe)]);
            middle = await startUpstream([relayService()], routeTo(() => leaf?.transport, ["catalogparity.v1.TargetService"]));
        },
        stop: async () => {
            await stopUpstream(middle);
            await stopUpstream(leaf);
        },
        services: () => [edgeService()],
        resolver: () => routeTo(() => middle?.transport, ["catalogparity.v1.RelayService"]),
    };
}

// ── Scenarios common to every topology ────────────────────────────────────

function registerRoutingScenarios(topology: Topology): void {
    const { entry, prefix } = topology;
    const options = () => ({ services: topology.services(), catalog: serviceCatalog, remoteResolver: topology.resolver() });
    const name = (title: string) => `catalog parity, ${topology.name}: ${title}`;

    transportParityTest(name("ctx.call answers the unary response of the target"), {
        ...options(),
        scenario: async ({ transport }) => ({ response: plain(await entryClient(transport, entry).echo({ value: "a", sequence: 7 })) }),
        compare: expecting({ response: { value: `${prefix}target:a`, sequence: 7 } }),
    });

    transportParityTest(name("ctx.stream delivers a server stream in order"), {
        ...options(),
        scenario: async ({ transport }) => {
            const received: Plain[] = [];
            for await (const reply of entryClient(transport, entry).count({ value: "v", sequence: 3 })) {
                received.push(plain(reply));
            }
            return { response: received };
        },
        compare: expecting({
            response: [
                { value: `${prefix}v#1`, sequence: 1 },
                { value: `${prefix}v#2`, sequence: 2 },
                { value: `${prefix}v#3`, sequence: 3 },
            ],
        }),
    });

    transportParityTest(name("ctx.stream aggregates a client stream into one response"), {
        ...options(),
        scenario: async ({ transport }) => {
            const total = await entryClient(transport, entry).sum(sending([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]));
            return { response: { count: total.count, sum: total.sum } };
        },
        compare: expecting({ response: { count: 3, sum: 6 } }),
    });

    transportParityTest(name("ctx.stream carries a bidi stream in both directions"), {
        ...options(),
        scenario: async ({ transport }) => {
            const received: Plain[] = [];
            for await (const reply of entryClient(transport, entry).chat(sending([{ value: "a", sequence: 1 }, { value: "b", sequence: 2 }, { value: "c", sequence: 3 }]))) {
                received.push(plain(reply));
            }
            return { response: received };
        },
        compare: expecting({
            response: [
                { value: `${prefix}target:a`, sequence: 1 },
                { value: `${prefix}target:b`, sequence: 2 },
                { value: `${prefix}target:c`, sequence: 3 },
            ],
        }),
    });

    // ── Connect error of the target ───────────────────────────────────────

    transportParityTest(name("a Connect error of the target reaches the caller unchanged (unary)"), {
        ...options(),
        scenario: async ({ transport }) => {
            try {
                await entryClient(transport, entry).echo({ value: "x", failCode: Code.NotFound });
            } catch (error) {
                return { error: failure(error) };
            }
            assert.fail("the call must fail");
        },
        compare: expecting({ error: { code: Code.NotFound, message: "target refused x" } }),
    });

    transportParityTest(name("a Connect error after some messages is delivered after them (server stream)"), {
        ...options(),
        scenario: async ({ transport }) => {
            const received: Plain[] = [];
            try {
                for await (const reply of entryClient(transport, entry).count({ value: "v", sequence: 2, failCode: Code.AlreadyExists })) {
                    received.push(plain(reply));
                }
            } catch (error) {
                return { response: received, error: failure(error) };
            }
            assert.fail("the stream must fail");
        },
        compare: expecting({
            response: [
                { value: `${prefix}v#1`, sequence: 1 },
                { value: `${prefix}v#2`, sequence: 2 },
            ],
            error: { code: Code.AlreadyExists, message: "target refused v" },
        }),
    });

    transportParityTest(name("a Connect error of the target fails the client stream"), {
        ...options(),
        scenario: async ({ transport }) => {
            try {
                await entryClient(transport, entry).sum(sending([{ sequence: 1 }, { value: "bad", sequence: 2, failCode: Code.OutOfRange }]));
            } catch (error) {
                return { error: failure(error) };
            }
            assert.fail("the call must fail");
        },
        compare: expecting({ error: { code: Code.OutOfRange, message: "target refused bad" } }),
    });

    transportParityTest(name("a Connect error after a bidi message is delivered after the replies before it"), {
        ...options(),
        scenario: async ({ transport }) => {
            const received: Plain[] = [];
            try {
                for await (const reply of entryClient(transport, entry).chat(sending([{ value: "a", sequence: 1 }, { value: "bad", sequence: 2, failCode: Code.DataLoss }]))) {
                    received.push(plain(reply));
                }
            } catch (error) {
                return { response: received, error: failure(error) };
            }
            assert.fail("the stream must fail");
        },
        compare: expecting({
            response: [{ value: `${prefix}target:a`, sequence: 1 }],
            error: { code: Code.DataLoss, message: "target refused bad" },
        }),
    });

    // ── Cancellation ──────────────────────────────────────────────────────

    transportParityTest(name("cancelling a unary call cancels the target"), {
        ...options(),
        scenario: async ({ transport }) => {
            probe.current = newLeafProbe();
            const abort = new AbortController();
            const call = entryClient(transport, entry).echo({ value: "h", hold: true }, { signal: abort.signal });
            const settled = call.then(
                () => undefined,
                (error: unknown) => error,
            );
            assert.ok(await happensWithin(probe.current.started.promise), "the target must start the call");
            abort.abort();
            const error = await settled;
            return { response: { targetCancelled: await happensWithin(probe.current.aborted.promise) }, error: failure(error) };
        },
        compare: (http, local) => {
            for (const result of [http, local]) {
                assert.deepStrictEqual(result.response, { targetCancelled: true });
                assert.strictEqual(result.error?.code, Code.Canceled);
            }
            assert.deepStrictEqual(local, http, "cancelled-call outcome must be identical on both transports");
        },
    });

    transportParityTest(name("cancelling a server stream cancels the target"), {
        ...options(),
        scenario: async ({ transport }) => {
            probe.current = newLeafProbe();
            const abort = new AbortController();
            let error: unknown;
            let received = 0;
            try {
                for await (const _reply of entryClient(transport, entry).count({ value: "h", hold: true }, { signal: abort.signal })) {
                    received++;
                    if (received === 2) {
                        abort.abort();
                    }
                }
            } catch (caught) {
                error = caught;
            }
            return { response: { targetCancelled: await happensWithin(probe.current.aborted.promise) }, error: failure(error) };
        },
        compare: (http, local) => {
            for (const result of [http, local]) {
                assert.deepStrictEqual(result.response, { targetCancelled: true });
                assert.strictEqual(result.error?.code, Code.Canceled);
            }
            assert.deepStrictEqual(local, http, "cancelled-stream outcome must be identical on both transports");
        },
    });
}

for (const topology of [localToLocal(), localToRemote(), remoteToRemote()]) {
    describe(`catalog parity, ${topology.name}`, () => {
        before(() => topology.start());
        after(() => topology.stop());
        registerRoutingScenarios(topology);
    });
}

// ── Calls that no route can serve ─────────────────────────────────────────

describe("catalog parity, calls without a route", () => {
    let unreachable: Transport | undefined;
    before(async () => {
        // A transport to an address nothing listens on: the port of a server that has been stopped.
        const gone = await startUpstream([]);
        const port = gone.server.address?.port;
        await stopUpstream(gone);
        unreachable = createGrpcTransport({ baseUrl: `http://localhost:${port}` });
    });

    const noRoute = () => ({ services: [probeService()], catalog: serviceCatalog, remoteResolver: (() => null) as RemoteResolver });
    const name = (title: string) => `catalog parity, no route: ${title}`;

    async function probeCall(transport: Transport, method: "orphan" | "unknownService" | "unknownMethod" | "wrongKind"): Promise<ParityScenarioResult> {
        try {
            await createClient(ProbeService, transport)[method]({ value: "p" });
        } catch (error) {
            return { error: failure(error) };
        }
        assert.fail("the call must fail");
    }

    transportParityTest(name("a catalog service nobody serves is Unavailable when the resolver has no route"), {
        ...noRoute(),
        scenario: ({ transport }) => probeCall(transport, "orphan"),
        compare: (http, local) => {
            assert.strictEqual(http.error?.code, Code.Unavailable);
            assert.strictEqual(local.error?.code, Code.Unavailable);
            assert.match(http.error?.message ?? "", /OrphanService/, "the error must name the service it could not route");
            defaultCompare(http, local);
        },
    });

    transportParityTest(name("a service the catalog does not contain is Unimplemented"), {
        ...noRoute(),
        scenario: ({ transport }) => probeCall(transport, "unknownService"),
        compare: (http, local) => {
            assert.strictEqual(http.error?.code, Code.Unimplemented);
            assert.strictEqual(local.error?.code, Code.Unimplemented);
            defaultCompare(http, local);
        },
    });

    transportParityTest(name("a method the catalog service does not have is Unimplemented"), {
        ...noRoute(),
        scenario: ({ transport }) => probeCall(transport, "unknownMethod"),
        compare: (http, local) => {
            assert.strictEqual(http.error?.code, Code.Unimplemented);
            assert.strictEqual(local.error?.code, Code.Unimplemented);
            defaultCompare(http, local);
        },
    });

    transportParityTest(name("a streaming method called through ctx.call is Unimplemented"), {
        ...noRoute(),
        scenario: ({ transport }) => probeCall(transport, "wrongKind"),
        compare: (http, local) => {
            assert.strictEqual(http.error?.code, Code.Unimplemented);
            assert.strictEqual(local.error?.code, Code.Unimplemented);
            defaultCompare(http, local);
        },
    });

    transportParityTest(name("a remote service that is down is Unavailable"), {
        services: [relayService()],
        catalog: serviceCatalog,
        remoteResolver: () => unreachable ?? null,
        scenario: async ({ transport }) => {
            try {
                await createClient(RelayService, transport).echo({ value: "p" });
            } catch (error) {
                return { error: failure(error) };
            }
            assert.fail("the call must fail");
        },
        compare: (http, local) => {
            assert.strictEqual(http.error?.code, Code.Unavailable);
            assert.strictEqual(local.error?.code, Code.Unavailable);
            defaultCompare(http, local);
        },
    });
});
