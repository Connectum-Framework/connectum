// Behavioral smoke against the PACKED artifacts of the release candidate.
// Scope: functions not already exercised by the example e2e suites, with no
// brokers and no auth interceptors. Server shutdown checks open loopback
// sockets (HTTP/2 and TCP) to observe drain and force-close. Each check is
// isolated and asserts real semantics where known. Signatures are not checked
// here (this file runs type-stripped): usage.ts and usage-typecheck.mjs do that.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { GreeterService, HelloReplySchema, HelloRequestSchema } from "../gen/greeter/v1/greeter_pb.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, fn: () => void) {
    try {
        fn();
        pass++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        fails.push(`${name}: ${(e as Error)?.message ?? e}`);
        console.log(`  FAIL ${name} :: ${(e as Error)?.message ?? e}`);
    }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        pass++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        fails.push(`${name}: ${(e as Error)?.message ?? e}`);
        console.log(`  FAIL ${name} :: ${(e as Error)?.message ?? e}`);
    }
}

// ---------- @connectum/core: catalog ----------
const core = await import("@connectum/core");
check("core.defineCatalog accepts matching key===typeName", () => {
    const cat = core.defineCatalog({ "greeter.v1.GreeterService": GreeterService });
    assert.ok(cat, "catalog truthy");
});
check("core.defineCatalog throws on key !== typeName (CatalogConfigError)", () => {
    assert.throws(
        () => core.defineCatalog({ "wrong.Name": GreeterService } as never),
        (e: unknown) => e instanceof core.CatalogConfigError || (e as Error).name === "CatalogConfigError",
        "expected CatalogConfigError",
    );
});
check("core.mergeCatalogs merges two catalogs", () => {
    const a = core.defineCatalog({ "greeter.v1.GreeterService": GreeterService });
    const merged = core.mergeCatalogs(a, core.defineCatalog({}));
    assert.ok(merged);
});
check("core.mergeCatalogs throws CatalogConfigError on duplicate typeName", () => {
    const a = core.defineCatalog({ "greeter.v1.GreeterService": GreeterService });
    assert.throws(
        () => core.mergeCatalogs(a, a),
        (e: unknown) => e instanceof core.CatalogConfigError || (e as Error).name === "CatalogConfigError",
        "expected CatalogConfigError on duplicate typeName",
    );
});
check("core.CatalogConfigError is an Error subclass", () => {
    const e = new core.CatalogConfigError("x");
    assert.ok(e instanceof Error);
});

// ---------- @connectum/core: resolvers ----------
check("core.singleTransportResolver wraps a transport into a resolver", () => {
    const t = createGrpcTransport({ baseUrl: "http://localhost:1" });
    const r = core.singleTransportResolver(t);
    assert.strictEqual(typeof r, "function");
});
check("core.mapResolver constructs", () => {
    const r = core.mapResolver({} as never);
    assert.strictEqual(typeof r, "function");
});
check("core.dnsResolver constructs from a template and resolves a service to a transport", () => {
    const r = core.dnsResolver({ template: "http://{shortName}.svc.local:5000" });
    assert.strictEqual(typeof r, "function");
    const transport = r({ typeName: "greeter.v1.GreeterService" });
    assert.ok(transport !== null && typeof transport.unary === "function" && typeof transport.stream === "function", "a transport");
});
check("core.dnsResolver throws CatalogConfigError naming template when it is missing", () => {
    assert.throws(
        () => core.dnsResolver({ port: 5000 } as never),
        (e: unknown) => (e as Error).name === "CatalogConfigError" && /template/.test((e as Error).message),
        "expected CatalogConfigError naming template",
    );
});
check("core.perServiceEnvResolver constructs", () => {
    const r = core.perServiceEnvResolver({} as never);
    assert.strictEqual(typeof r, "function");
});

// ---------- @connectum/core: enabledServices + propagateHeaders + env ----------
check("core.defaultPropagateHeaders is a non-empty list of trace headers", () => {
    const h = core.defaultPropagateHeaders;
    const arr = Array.isArray(h) ? h : [...(h as Iterable<string>)];
    assert.ok(arr.length > 0, "non-empty");
    assert.ok(
        arr.some((x) => /trace|baggage/i.test(x)),
        `contains a trace header: ${arr.join(",")}`,
    );
});
check("core.matchServicesPattern('*', names) returns matching names", () => {
    const r = core.matchServicesPattern("*", ["greeter.v1.GreeterService", "other.v1.Svc"]);
    assert.ok(Array.isArray(r) && r.includes("greeter.v1.GreeterService"), `got ${JSON.stringify(r)}`);
});
check("core.parseServicesEnv parses a CSV list", () => {
    const r = core.parseServicesEnv("a.B,c.D");
    assert.ok(r);
});
check("core.enabledServicesFromEnv keeps undefined for an unset value and lists the named services", () => {
    assert.equal(core.enabledServicesFromEnv(undefined), undefined);
    assert.deepEqual(core.enabledServicesFromEnv(" a.v1.B , c.v1.D "), ["a.v1.B", "c.v1.D"]);
});
check("core.safeParseEnvConfig returns a result for minimal env", () => {
    const r = core.safeParseEnvConfig({ NODE_ENV: "production" } as never);
    assert.ok(r);
});

// ---------- @connectum/interceptors: defaultFailurePredicate classification ----------
const itc = await import("@connectum/interceptors");
check("interceptors.defaultFailurePredicate: unavailable => true (infra)", () => {
    assert.strictEqual(itc.defaultFailurePredicate(new ConnectError("x", Code.Unavailable)), true);
});
check("interceptors.defaultFailurePredicate: invalid_argument => false (business)", () => {
    assert.strictEqual(itc.defaultFailurePredicate(new ConnectError("x", Code.InvalidArgument)), false);
});
check("interceptors.defaultFailurePredicate: non-ConnectError => true", () => {
    assert.strictEqual(itc.defaultFailurePredicate(new Error("boom")), true);
});
check("interceptors.createDefaultInterceptors bare = [errorHandler, validation] only", () => {
    const arr = itc.createDefaultInterceptors();
    assert.ok(Array.isArray(arr) && arr.length === 2, `expected exactly 2, got ${(arr as unknown[]).length}`);
});

// ---------- @connectum/otel: provider getters ----------
const otel = await import("@connectum/otel");
check("otel.getTracer/getMeter/getLogger return objects pre-init (no-op safe)", () => {
    assert.ok(otel.getTracer());
    assert.ok(otel.getMeter());
    assert.ok(otel.getLogger("consumer"));
});
check("otel.initProvider + shutdownProvider are functions", () => {
    assert.strictEqual(typeof otel.initProvider, "function");
    assert.strictEqual(typeof otel.shutdownProvider, "function");
});
check("otel.initProvider rejects an unknown exporter name in settings", () => {
    assert.throws(() => otel.initProvider({ settings: { traces: "bogus" as never } }), TypeError);
});
await checkAsync("otel.shutdownProvider rejects a timeout that is not a positive number", async () => {
    await assert.rejects(otel.shutdownProvider({ timeout: 0 }), TypeError);
});

// ---------- @connectum/auth: pure header helpers + pattern ----------
const auth = await import("@connectum/auth");
check("auth.setAuthHeaders/parseAuthHeaders round-trip preserves subject", () => {
    const h = new Headers();
    const ctx = { subject: "user-1", roles: ["admin"], scopes: ["read"], claims: { iss: "test" }, type: "jwt" };
    auth.setAuthHeaders(h, ctx);
    const parsed = auth.parseAuthHeaders(h);
    assert.ok(parsed, "parsed truthy");
    assert.strictEqual(parsed?.subject, "user-1");
});
check("auth.matchesMethodPattern discriminates matching vs non-matching", () => {
    assert.strictEqual(auth.matchesMethodPattern("greeter.v1.GreeterService", "SayHello", ["greeter.v1.GreeterService/*"]), true);
    assert.strictEqual(auth.matchesMethodPattern("greeter.v1.GreeterService", "SayHello", ["other.v1.Svc/X"]), false);
});

// ---------- @connectum/healthcheck ----------
const hc = await import("@connectum/healthcheck");
check("healthcheck.ServingStatus enum + manager singleton", () => {
    assert.ok(hc.ServingStatus.SERVING !== null && hc.ServingStatus.SERVING !== undefined);
    assert.ok(hc.healthcheckManager);
    const m = hc.createHealthcheckManager();
    assert.ok(m);
});
check("healthcheck: the manager refuses a bad status and announces changes; Healthcheck() refuses a bad watchInterval", () => {
    const m = hc.createHealthcheckManager();
    let announced = 0;
    m.subscribe(() => announced++);
    m.set("db", hc.ServingStatus.SERVING);
    assert.strictEqual(announced, 1);
    assert.throws(() => m.set("db", "SERVING" as never), TypeError);
    assert.throws(() => m.set("db", 99 as never), RangeError);
    assert.strictEqual(m.getStatus("db")?.status, hc.ServingStatus.SERVING);
    assert.strictEqual(announced, 1, "a refused call does not announce");
    assert.throws(() => hc.Healthcheck({ watchInterval: 0 }), RangeError);
    assert.throws(() => hc.createHttpHealthHandler(m, []), RangeError);
    assert.strictEqual(hc.Healthcheck({ manager: m, watchInterval: 500 }).name, "healthcheck");
});

// ---------- @connectum/events: bus + pure helpers ----------
const ev = await import("@connectum/events");
check("events.createEventBus with MemoryAdapter constructs", () => {
    const bus = ev.createEventBus({ adapter: ev.MemoryAdapter() } as never);
    assert.ok(bus);
});
check("events.matchPattern(pattern, topic): '*'=one segment, '>'=multi", () => {
    assert.strictEqual(ev.matchPattern("orders.*", "orders.created"), true);
    assert.strictEqual(ev.matchPattern("orders.*", "orders.created.v2"), false);
    assert.strictEqual(ev.matchPattern("orders.>", "orders.created.v2"), true);
});
check("events.RetryableError/NonRetryableError are Error subclasses", () => {
    assert.ok(new ev.RetryableError("x") instanceof Error);
    assert.ok(new ev.NonRetryableError("x") instanceof Error);
});

// ---------- option descriptors: one module behind the subpath and the package ----------
// Code generated with protoc-gen-es `map_imports` imports Connectum's option
// descriptors from these subpaths. If the build gave the subpath its own copy of
// the generated module, the package would evaluate the option proto twice and the
// subpath would hand out descriptor objects its own runtime never uses — these
// checks fail on such a build.
const authProto = await import("@connectum/auth/proto");
const authOptions = await import("@connectum/auth/gen/connectum/auth/v1/options_pb.js");
check("auth option descriptors: the subpath and ./proto hand out the same objects", () => {
    assert.strictEqual(authOptions.method_auth, authProto.method_auth, "method_auth differs");
    assert.strictEqual(authOptions.service_auth, authProto.service_auth, "service_auth differs");
    assert.strictEqual(authOptions.MethodAuthSchema, authProto.MethodAuthSchema, "MethodAuthSchema differs");
    assert.strictEqual(authProto.MethodAuthSchema.file, authOptions.file_connectum_auth_v1_options, "the schema belongs to another file descriptor");
});
const eventsOptions = await import("@connectum/events/gen/connectum/events/v1/options_pb.js");
check("events option descriptors: the subpath exports the file descriptor and the extension", () => {
    // protobuf-es names a DescFile by its proto path without the `.proto` suffix.
    assert.strictEqual(eventsOptions.file_connectum_events_v1_options.name, "connectum/events/v1/options");
    assert.strictEqual(eventsOptions.event.typeName, "connectum.events.v1.event");
});
/** The files of a package's `dist/` that evaluate a file descriptor (`fileDesc(`). */
function descriptorFiles(dist: string): string[] {
    return readdirSync(dist, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".js"))
        .map((file) => join(dist, file))
        .filter((file) => readFileSync(file, "utf8").includes("fileDesc("));
}
// The option proto is the only proto these packages generate, so exactly one file of
// each build may evaluate a descriptor. This also covers entries the identity checks
// do not import: a build that inlined a second copy into `dist/index.js` fails here.
check("auth option descriptors: exactly one file of the build evaluates them", () => {
    const dist = dirname(fileURLToPath(import.meta.resolve("@connectum/auth")));
    const holders = descriptorFiles(dist);
    assert.strictEqual(holders.length, 1, `expected one file with fileDesc( in ${dist}, got ${holders.length}: ${holders.join(", ")}`);
});
// `@connectum/events` exports no descriptor from its entry, so object identity cannot
// be compared there; module identity is read from the installed build instead (Node
// 22.13 has no module.registerHooks to observe resolution).
check("events option descriptors: one file evaluates them, imported by index.js and the subpath", () => {
    const entry = fileURLToPath(import.meta.resolve("@connectum/events"));
    const subpath = fileURLToPath(import.meta.resolve("@connectum/events/gen/connectum/events/v1/options_pb.js"));
    const dist = dirname(entry);
    const holders = descriptorFiles(dist);
    assert.strictEqual(holders.length, 1, `expected one file with fileDesc( in ${dist}, got ${holders.length}: ${holders.join(", ")}`);
    for (const importer of [entry, subpath]) {
        const imported = [...readFileSync(importer, "utf8").matchAll(/(?:from\s+|import\s+)"(\.\.?\/[^"]+)"/g)].map((m) => resolve(dirname(importer), m[1] ?? ""));
        assert.ok(imported.includes(holders[0] ?? ""), `${importer} does not import ${holders[0]}`);
    }
});

// Only the explicit option-descriptor subpaths are public: the rest of the generated
// tree, which the tarball also ships under gen/, must stay unimportable, or it becomes
// contract by accident.
for (const spec of ["@connectum/auth/gen/connectum/auth/v1/options_pb.ts", "@connectum/events/gen/connectum/events/v1/options_pb.ts"]) {
    await checkAsync(`${spec} is not exported`, async () => {
        await assert.rejects(
            () => import(spec),
            (e: unknown) => (e as { code?: string }).code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
        );
    });
}

// ---------- @connectum/testing: mocks ----------
const testing = await import("@connectum/testing");
check("testing.createMockContext returns a Context for a catalog", () => {
    const ctx = testing.createMockContext({
        catalog: core.defineCatalog({ "greeter.v1.GreeterService": GreeterService }),
        mocks: [],
    });
    assert.ok(ctx && typeof ctx === "object");
    assert.strictEqual(typeof ctx.call, "function");
});
// Full catalog-call cardinality coverage: ctx.call (unary) + ctx.stream
// (server/client/bidi) dispatched through createMockContext — the in-process
// mock/local resolver path. Remote dispatch over a real gRPC transport
// (createGrpcTransport) is exercised by the service-catalog example e2e (ctx.call)
// and the transport-parity suite (createLocalTransport vs createGrpcTransport at
// the service level); a full 2-server remote ctx.stream matrix is out of scope
// for this smoke. See PR notes for the coverage map.
const catalogCtx = testing.createMockContext({
    catalog: core.defineCatalog({ "greeter.v1.GreeterService": GreeterService }),
    mocks: [
        testing.mockService(GreeterService, {
            sayHello: (req: { name: string }) => create(HelloReplySchema, { message: `u:${req.name}` }),
            async *sayHelloStream(req: { name: string }) {
                yield create(HelloReplySchema, { message: `s:${req.name}` });
            },
            async sayHelloCollect(reqs: AsyncIterable<{ name: string }>) {
                let last = "";
                for await (const r of reqs) last = r.name;
                return create(HelloReplySchema, { message: `c:${last}` });
            },
            async *sayHelloChat(reqs: AsyncIterable<{ name: string }>) {
                for await (const r of reqs) yield create(HelloReplySchema, { message: `b:${r.name}` });
            },
        }),
    ],
});
await checkAsync("ctx.call — unary dispatch through the catalog (mock/local)", async () => {
    const res = await catalogCtx.call("greeter.v1.GreeterService/SayHello", create(HelloRequestSchema, { name: "x" }));
    assert.strictEqual((res as { message: string }).message, "u:x");
});
await checkAsync("ctx.stream — server-stream dispatch (mock/local)", async () => {
    const out: string[] = [];
    for await (const r of catalogCtx.stream("greeter.v1.GreeterService/SayHelloStream")(create(HelloRequestSchema, { name: "x" }))) {
        out.push((r as { message: string }).message);
    }
    assert.deepStrictEqual(out, ["s:x"]);
});
await checkAsync("ctx.stream — client-stream dispatch (mock/local)", async () => {
    const h = catalogCtx.stream("greeter.v1.GreeterService/SayHelloCollect")();
    h.send(create(HelloRequestSchema, { name: "a" }));
    h.send(create(HelloRequestSchema, { name: "b" }));
    const res = await h.close();
    assert.strictEqual((res as { message: string }).message, "c:b");
});
await checkAsync("ctx.stream — bidi dispatch (mock/local)", async () => {
    const h = catalogCtx.stream("greeter.v1.GreeterService/SayHelloChat")();
    h.send(create(HelloRequestSchema, { name: "a" }));
    h.send(create(HelloRequestSchema, { name: "b" }));
    h.close();
    const out: string[] = [];
    for await (const r of h.responses) out.push((r as { message: string }).message);
    assert.deepStrictEqual(out, ["b:a", "b:b"]);
});
check("testing.mockResolver + mockService are callable", () => {
    assert.strictEqual(typeof testing.mockResolver, "function");
    assert.strictEqual(typeof testing.mockService, "function");
});
check("testing.assertConnectError validates a ConnectError", () => {
    const fn = testing.assertConnectError as (e: unknown, code?: unknown) => void;
    fn(new ConnectError("x", Code.NotFound), Code.NotFound);
});
check("testing.createMockContext describes the method named by `method`", () => {
    const ctx = testing.createMockContext({
        catalog: core.defineCatalog({ "greeter.v1.GreeterService": GreeterService }),
        mocks: [],
        method: "greeter.v1.GreeterService/SayHelloStream",
    });
    assert.strictEqual(ctx.service.typeName, "greeter.v1.GreeterService");
    assert.strictEqual(ctx.method.name, "SayHelloStream");
    assert.throws(
        () => testing.createMockContext({ catalog: core.defineCatalog({ "greeter.v1.GreeterService": GreeterService }), mocks: [], method: "greeter.v1.GreeterService/Nope" }),
        (e: unknown) => e instanceof TypeError && /options\.method/.test(e.message),
    );
});
await checkAsync("testing.mockService — an exception in the implementation keeps its message and cause", async () => {
    const typo = new TypeError("typo in the mock");
    const ctx = testing.createMockContext({
        catalog: core.defineCatalog({ "greeter.v1.GreeterService": GreeterService }),
        mocks: [
            testing.mockService(GreeterService, {
                sayHello: () => {
                    throw typo;
                },
            }),
        ],
    });
    await assert.rejects(ctx.call("greeter.v1.GreeterService/SayHello", create(HelloRequestSchema, { name: "x" })), (e: unknown) => {
        const err = ConnectError.from(e);
        return err.code === Code.Internal && err.rawMessage === "typo in the mock" && err.cause === typo;
    });
});
await checkAsync("testing.InMemoryMetricCollector.flush() reports only what was recorded since the previous flush", async () => {
    const collector = new testing.InMemoryMetricCollector();
    const hits = collector.provider.getMeter("smoke").createCounter("hits");
    hits.add(1);
    assert.deepStrictEqual(
        (await collector.flush()).map((m) => m.points.map((p) => p.value)),
        [[1]],
    );
    hits.add(5);
    assert.deepStrictEqual(
        (await collector.flush()).map((m) => m.points.map((p) => p.value)),
        [[5]],
    );
    await collector.dispose();
    await assert.rejects(collector.flush(), /after dispose/);
});
await checkAsync("testing.createTestServer — loopback by default, wrong service rejected by option name, shutdown timeout bounds close()", async () => {
    const routes = core.defineService(GreeterService, {
        sayHello: (req: { name: string }) => create(HelloReplySchema, { message: `hi ${req.name}` }),
    });
    await assert.rejects(testing.createTestServer({ services: ["nope"] } as never), (e: unknown) => e instanceof TypeError && /services\[0\]/.test(e.message));
    const server = await testing.createTestServer({ services: [routes], shutdown: { timeout: 500 } });
    try {
        const reply = await createClient(GreeterService, server.transport).sayHello(create(HelloRequestSchema, { name: "x" }));
        assert.strictEqual(reply.message, "hi x");
        assert.strictEqual(new URL(server.baseUrl).hostname, "localhost");
        const external = Object.values(networkInterfaces())
            .flat()
            .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;
        if (external !== undefined) {
            const reach = (host: string) =>
                new Promise<boolean>((resolveReach) => {
                    const socket = connect({ port: server.port, host });
                    socket.once("connect", () => {
                        socket.destroy();
                        resolveReach(true);
                    });
                    socket.once("error", () => {
                        socket.destroy();
                        resolveReach(false);
                    });
                });
            assert.strictEqual(await reach("127.0.0.1"), true);
            assert.strictEqual(await reach(external), false, `${external} must refuse connections`);
        }
    } finally {
        await server.close();
    }
});

// ---------- @connectum/core: shutdown ----------
// Runs on the consumer floor (Node 22.13) against the packed artifacts: Node 22's
// server.close() sends no GOAWAY and its connection handling differs from 24+,
// so this is the only CI cell that guards the drain and force-close paths there.

/** Resolve true if the socket is closed by the server within `ms`. */
function closedWithin(socket: import("node:net").Socket, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        const done = () => {
            clearTimeout(timer);
            resolve(true);
        };
        socket.once("end", done);
        socket.once("close", done);
    });
}

await checkAsync("core server.stop() drains an idle HTTP/2 client with GOAWAY before the timeout", async () => {
    const { connect } = await import("node:http2");
    const server = core.createServer({ services: [], port: 0, allowHTTP1: false, shutdown: { timeout: 5000 } });
    await server.start();
    const session = connect(`http://127.0.0.1:${server.address?.port}`);
    session.on("error", () => {});
    session.on("goaway", () => session.close());
    await new Promise<void>((resolve) => session.once("connect", () => resolve()));
    const startedAt = Date.now();
    await server.stop();
    session.destroy();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 2000, `stop() took ${elapsed}ms: the idle session was not asked to go away`);
});

await checkAsync("core server.stop() force-closes a client that never closes (forceCloseOnTimeout)", async () => {
    const { connect } = await import("node:net");
    const server = core.createServer({ services: [], port: 0, shutdown: { timeout: 300, forceCloseOnTimeout: true } });
    await server.start();
    // Default plaintext transport (HTTP/1.1): an unfinished request on a client
    // that ignores the server's FIN and never closes its side.
    const client = connect({ port: server.address?.port ?? 0, host: "127.0.0.1", allowHalfOpen: true });
    client.on("error", () => {});
    client.resume();
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("GET / HTTP/1.1\r\nHost: loc");
    const closedByServer = closedWithin(client, 3000);
    await server.stop();
    const closed = await closedByServer;
    client.destroy();
    assert.ok(closed, "the connection outlived the shutdown timeout despite forceCloseOnTimeout");
});

// ---------- @connectum/reflection: stream lifetime, own service, request bound ----------
// Raw HTTP/2 against the packed artifacts: a hand-encoded ServerReflectionRequest
// (field tag, varint length, bytes) in one gRPC frame, read back as text.

const reflection = await import("@connectum/reflection");

const REFLECTION_PATH = "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo";
const LIST_SERVICES = 0x3a;
const FILE_BY_FILENAME = 0x1a;
const FILE_CONTAINING_SYMBOL = 0x22;

function reflectionFrame(tag: number, text: string): Buffer {
    const value = Buffer.from(text);
    // Protobuf varint: seven bits per byte, low bits first, high bit set while more follow.
    const length: number[] = [];
    let remaining = value.length;
    while (remaining > 127) {
        length.push((remaining % 128) + 128);
        remaining = Math.floor(remaining / 128);
    }
    length.push(remaining);
    const message = Buffer.concat([Buffer.from([tag, ...length]), value]);
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length, 1);
    return Buffer.concat([header, message]);
}

/** One reflection call over HTTP/2: what the server sent back, and when the stream closed. */
async function reflectionCall(port: number, frame: Buffer, options: { keepOpen: boolean }) {
    const { connect } = await import("node:http2");
    const session = connect(`http://127.0.0.1:${port}`);
    session.on("error", () => {});
    const request = session.request({ ":method": "POST", ":path": REFLECTION_PATH, "content-type": "application/grpc", te: "trailers" }, { endStream: false });
    request.on("error", () => {});
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve) => request.once("close", () => resolve()));
    request.write(frame);
    if (!options.keepOpen) request.end();
    return {
        text: () => Buffer.concat(chunks).toString("latin1"),
        received: () => Buffer.concat(chunks).length,
        closed,
        end() {
            request.close();
            session.destroy();
        },
    };
}

async function untilReceived(call: { received(): number }, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (call.received() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(call.received() > 0, "the server sent no answer");
}

await checkAsync("reflection: server.stop() ends a stream the client keeps open instead of waiting for the timeout", async () => {
    const server = core.createServer({ services: [], port: 0, allowHTTP1: false, protocols: [reflection.Reflection()], shutdown: { timeout: 8000 } });
    await server.start();
    const call = await reflectionCall(server.address?.port ?? 0, reflectionFrame(LIST_SERVICES, ""), { keepOpen: true });
    try {
        await untilReceived(call, 3000);
        const startedAt = Date.now();
        await server.stop();
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed < 3000, `stop() took ${elapsed}ms with a reflection stream open; shutdown.timeout was 8000ms`);
    } finally {
        call.end();
    }
});

await checkAsync("reflection: file_containing_symbol describes the reflection service itself", async () => {
    const server = core.createServer({ services: [], port: 0, allowHTTP1: false, protocols: [reflection.Reflection()] });
    await server.start();
    const call = await reflectionCall(server.address?.port ?? 0, reflectionFrame(FILE_CONTAINING_SYMBOL, "grpc.reflection.v1.ServerReflection"), { keepOpen: false });
    try {
        await call.closed;
        assert.ok(call.text().includes("grpc/reflection/v1/reflection.proto"), `unexpected answer: ${call.text().replace(/[^\x20-\x7e]+/g, " ")}`);
        assert.ok(!call.text().includes("symbol not found"));
    } finally {
        call.end();
        await server.stop();
    }
});

await checkAsync("reflection: an unknown long name is echoed in part in error_message", async () => {
    const server = core.createServer({ services: [], port: 0, allowHTTP1: false, protocols: [reflection.Reflection()] });
    await server.start();
    try {
        const bounded = await reflectionCall(server.address?.port ?? 0, reflectionFrame(FILE_BY_FILENAME, "a".repeat(10_000)), { keepOpen: false });
        await bounded.closed;
        // original_request carries the 10000 characters once; error_message only a prefix.
        const answer = bounded.text();
        assert.ok(answer.includes(`file not found: "${"a".repeat(128)}…"`.replace("…", "â\u0080¦")), "error_message must repeat a 128-character prefix");
        assert.ok(answer.length < 11_000, `the answer has ${answer.length} bytes: the name was repeated in full`);
        bounded.end();
    } finally {
        await server.stop();
    }
});

console.log(`\nLayer-2 smoke: pass=${pass} fail=${fails.length}`);
if (fails.length) {
    for (const f of fails) console.log(`  XX ${f}`);
    process.exit(1);
}
