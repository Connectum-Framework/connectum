// Layer-2 behavioral smoke against the @137 (1.0.0) published artifacts.
// Scope: gap functions NOT already exercised by example e2e — pure / in-process
// only (no brokers). Each check is isolated; asserts real semantics where known.
import assert from "node:assert";
import { Code, ConnectError } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { GreeterService } from "../gen/greeter/v1/greeter_pb.ts";

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
check("testing.mockResolver + mockService are callable", () => {
    assert.strictEqual(typeof testing.mockResolver, "function");
    assert.strictEqual(typeof testing.mockService, "function");
});
check("testing.assertConnectError validates a ConnectError", () => {
    const fn = testing.assertConnectError as (e: unknown, code?: unknown) => void;
    fn(new ConnectError("x", Code.NotFound), Code.NotFound);
});

console.log(`\nLayer-2 smoke: pass=${pass} fail=${fails.length}`);
if (fails.length) {
    for (const f of fails) console.log(`  XX ${f}`);
    process.exit(1);
}
