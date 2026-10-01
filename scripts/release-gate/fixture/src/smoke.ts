// Layer-2 behavioral smoke against the @137 (1.0.0) published artifacts.
// Scope: gap functions NOT already exercised by example e2e — pure / in-process
// only (no brokers). Each check is isolated; asserts real semantics where known.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
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
check("core.dnsResolver constructs", () => {
    const r = core.dnsResolver({ port: 5000 } as never);
    assert.strictEqual(typeof r, "function");
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
    assert.ok(hc.ServingStatus.SERVING != null);
    assert.ok(hc.healthcheckManager);
    const m = hc.createHealthcheckManager();
    assert.ok(m);
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
// `@connectum/events` exports no descriptor from its entry, so object identity cannot
// be compared there; module identity is read from the installed build instead (Node
// 22.13 has no module.registerHooks to observe resolution).
check("events option descriptors: one file evaluates them, imported by index.js and the subpath", () => {
    const entry = fileURLToPath(import.meta.resolve("@connectum/events"));
    const subpath = fileURLToPath(import.meta.resolve("@connectum/events/gen/connectum/events/v1/options_pb.js"));
    const dist = dirname(entry);
    const holders = readdirSync(dist, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".js"))
        .map((file) => join(dist, file))
        .filter((file) => readFileSync(file, "utf8").includes("fileDesc("));
    assert.strictEqual(holders.length, 1, `expected one file with fileDesc( in ${dist}, got ${holders.length}: ${holders.join(", ")}`);
    for (const importer of [entry, subpath]) {
        const imported = [...readFileSync(importer, "utf8").matchAll(/(?:from\s+|import\s+)"(\.\.?\/[^"]+)"/g)].map((m) => resolve(dirname(importer), m[1] ?? ""));
        assert.ok(imported.includes(holders[0] ?? ""), `${importer} does not import ${holders[0]}`);
    }
});

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

console.log(`\nLayer-2 smoke: pass=${pass} fail=${fails.length}`);
if (fails.length) {
    for (const f of fails) console.log(`  XX ${f}`);
    process.exit(1);
}
