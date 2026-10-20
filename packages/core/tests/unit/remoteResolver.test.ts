/**
 * RemoteResolver helpers unit tests — singleTransportResolver, mapResolver.
 */

import assert from "node:assert";
import { once } from "node:events";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { dnsResolver, mapResolver, perServiceEnvResolver, singleTransportResolver } from "../../src/remoteResolver.ts";
import { EchoRequestSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

// Opaque Transport stand-ins — identity is all the resolvers need.
const tA = { id: "A" } as unknown as Transport;
const tB = { id: "B" } as unknown as Transport;

/**
 * Drive one unary call through `transport` against a bare h2c server and report
 * what reached the wire. The server answers with a gRPC "trailers-only"
 * Unimplemented, so the call settles as a ConnectError only when the client spoke
 * gRPC (a Connect-protocol client does not read `grpc-status`).
 */
async function probeWire(buildTransport: (baseUrl: string) => Transport): Promise<{ contentType: string | undefined; code: Code | undefined }> {
    const seen: { contentType: string | undefined } = { contentType: undefined };
    const server = http2.createServer();
    const sessions = new Set<http2.ServerHttp2Session>();
    server.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
        seen.contentType = headers["content-type"];
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": String(Code.Unimplemented) }, { endStream: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const transport = buildTransport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    let code: Code | undefined;
    try {
        await transport.unary(EchoService.method.echo, undefined, undefined, undefined, create(EchoRequestSchema, { message: "x" }));
    } catch (err) {
        code = ConnectError.from(err).code;
    } finally {
        for (const session of sessions) session.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return { contentType: seen.contentType, code };
}

describe("singleTransportResolver", () => {
    it("returns the same transport for any service", () => {
        const resolve = singleTransportResolver(tA);
        assert.equal(resolve({ typeName: "x.v1.A" }), tA);
        assert.equal(resolve({ typeName: "y.v1.B", endpoint: "hint" }), tA);
    });
});

describe("mapResolver", () => {
    const resolve = mapResolver({ "x.v1.A": tA, "y.v1.B": tB });
    it("resolves known typeNames", () => {
        assert.equal(resolve({ typeName: "x.v1.A" }), tA);
        assert.equal(resolve({ typeName: "y.v1.B" }), tB);
    });
    it("returns null for unknown typeNames", () => {
        assert.equal(resolve({ typeName: "z.v1.C" }), null);
    });
    it("ignores the endpoint hint: the map is keyed by typeName only", () => {
        assert.equal(resolve({ typeName: "x.v1.A", endpoint: "eu-west" }), tA);
        assert.equal(resolve({ typeName: "z.v1.C", endpoint: "eu-west" }), null);
    });
    it("returns null for a typeName that is not in the map even when it names an Object.prototype member", () => {
        // The guide: "any typeName not in the map resolves to null".
        for (const typeName of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__proto__"]) {
            assert.equal(resolve({ typeName }), null, `${typeName} is not in the map`);
            assert.equal(resolve({ typeName, endpoint: "eu-west" }), null, `${typeName} is not in the map, whatever the endpoint hint`);
        }
    });
    it("resolves an own key that has the name of an Object.prototype member", () => {
        const tT = { id: "T" } as unknown as Transport;
        const owning = mapResolver({ toString: tT, "x.v1.A": tA });
        assert.equal(owning({ typeName: "toString" }), tT);
        assert.equal(owning({ typeName: "toString", endpoint: "eu-west" }), tT);
        assert.equal(owning({ typeName: "x.v1.A" }), tA);
        assert.equal(owning({ typeName: "valueOf" }), null, "a sibling prototype name the map does not own stays unresolved");
    });
    it("keeps the lookup live: a key added to the map after creation resolves", () => {
        const live: Record<string, Transport> = { "x.v1.A": tA };
        const liveResolve = mapResolver(live);
        assert.equal(liveResolve({ typeName: "y.v1.B" }), null);
        live["y.v1.B"] = tB;
        assert.equal(liveResolve({ typeName: "y.v1.B" }), tB);
    });
});

// Capture the base URL passed to the transport factory instead of opening a socket.
const captureUrl = () => {
    let url: string | null = null;
    const createTransport = (baseUrl: string): Transport => {
        url = baseUrl;
        return { id: baseUrl } as unknown as Transport;
    };
    return { createTransport, get url() { return url; } };
};

describe("dnsResolver", () => {
    it("substitutes the short name into the template", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}.prod.svc:50051", createTransport: cap.createTransport });
        resolve({ typeName: "orders.v1.OrdersService" });
        assert.equal(cap.url, "http://orders.prod.svc:50051");
    });
    it("supports the {name} alias and strips the trailing Service", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "https://{name}:8443", createTransport: cap.createTransport });
        resolve({ typeName: "inventory.v2.InventoryService" });
        assert.equal(cap.url, "https://inventory:8443");
    });
    it("expands both placeholders and every occurrence of each to the same short name", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}.{name}.{shortName}/{name}", createTransport: cap.createTransport });
        resolve({ typeName: "billing.v1.BillingService" });
        assert.equal(cap.url, "http://billing.billing.billing/billing");
    });
    it("lower-cases the short name and takes only the last dot-segment of the typeName", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: cap.createTransport });
        resolve({ typeName: "Org.Team.v3.UserProfileService" });
        assert.equal(cap.url, "http://userprofile");
    });
    it("strips only a trailing Service and keeps a name that has none, or has it in the middle", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: cap.createTransport });
        resolve({ typeName: "a.v1.Billing" });
        assert.equal(cap.url, "http://billing");
        resolve({ typeName: "a.v1.ServiceRegistry" });
        assert.equal(cap.url, "http://serviceregistry");
        resolve({ typeName: "a.v1.ServiceRegistryService" });
        assert.equal(cap.url, "http://serviceregistry");
    });
    it("handles a typeName without a package", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: cap.createTransport });
        resolve({ typeName: "OrdersService" });
        assert.equal(cap.url, "http://orders");
    });
    it("leaves a template without placeholders unchanged", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://gateway:50051", createTransport: cap.createTransport });
        resolve({ typeName: "a.v1.AnyService" });
        assert.equal(cap.url, "http://gateway:50051");
    });
    it("ignores the endpoint hint when building the URL", () => {
        const cap = captureUrl();
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: cap.createTransport });
        resolve({ typeName: "a.v1.OrdersService", endpoint: "eu-west" });
        assert.equal(cap.url, "http://orders");
    });
    it("returns exactly the transport the factory built", () => {
        const built = { id: "built" } as unknown as Transport;
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: () => built });
        assert.equal(resolve({ typeName: "x.v1.A" }), built);
    });
    it("builds a gRPC (HTTP/2) transport when no factory is given", async () => {
        const wire = await probeWire((baseUrl) => dnsResolver({ template: baseUrl })({ typeName: "echo.v1.EchoService" }) as Transport);
        assert.match(wire.contentType ?? "", /^application\/grpc(\+proto)?$/);
        assert.equal(wire.code, Code.Unimplemented, "the client must read the gRPC trailers-only status");
    });
    it("always resolves (never null)", () => {
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: (u: string) => ({ id: u }) as unknown as Transport });
        assert.notEqual(resolve({ typeName: "x.v1.A" }), null);
    });
});

describe("perServiceEnvResolver", () => {
    it("resolves a mapped service whose env var is set", () => {
        const prev = process.env.TEST_ORDERS_URL;
        try {
            process.env.TEST_ORDERS_URL = "http://orders:5000";
            const cap = captureUrl();
            const resolve = perServiceEnvResolver({ "orders.v1.OrdersService": "TEST_ORDERS_URL" }, { createTransport: cap.createTransport });
            const t = resolve({ typeName: "orders.v1.OrdersService" });
            assert.notEqual(t, null);
            assert.equal(cap.url, "http://orders:5000");
        } finally {
            if (prev === undefined) delete process.env.TEST_ORDERS_URL;
            else process.env.TEST_ORDERS_URL = prev;
        }
    });
    it("returns null for an unmapped service", () => {
        const resolve = perServiceEnvResolver({ "orders.v1.OrdersService": "TEST_X" });
        assert.equal(resolve({ typeName: "other.v1.Service" }), null);
    });
    it("returns null when the mapped env var is unset", () => {
        delete process.env.TEST_MISSING_URL;
        const resolve = perServiceEnvResolver({ "x.v1.A": "TEST_MISSING_URL" });
        assert.equal(resolve({ typeName: "x.v1.A" }), null);
    });
    it("treats an empty env var as unset (→ null)", () => {
        const prev = process.env.TEST_EMPTY_URL;
        try {
            process.env.TEST_EMPTY_URL = "";
            const resolve = perServiceEnvResolver({ "x.v1.A": "TEST_EMPTY_URL" });
            assert.equal(resolve({ typeName: "x.v1.A" }), null);
        } finally {
            if (prev === undefined) delete process.env.TEST_EMPTY_URL;
            else process.env.TEST_EMPTY_URL = prev;
        }
    });
    it("passes the trimmed URL to the factory and returns the factory's transport", () => {
        const prev = process.env.TEST_PADDED_URL;
        try {
            process.env.TEST_PADDED_URL = "  http://padded:5000\n";
            const built = { id: "built" } as unknown as Transport;
            let received: string | undefined;
            const resolve = perServiceEnvResolver(
                { "x.v1.A": "TEST_PADDED_URL" },
                {
                    createTransport: (baseUrl) => {
                        received = baseUrl;
                        return built;
                    },
                },
            );
            assert.equal(resolve({ typeName: "x.v1.A", endpoint: "eu-west" }), built, "the endpoint hint does not affect the mapping");
            assert.equal(received, "http://padded:5000");
        } finally {
            if (prev === undefined) delete process.env.TEST_PADDED_URL;
            else process.env.TEST_PADDED_URL = prev;
        }
    });
    it("reads the variable at resolve time, not when the resolver is built", () => {
        const prev = process.env.TEST_LATE_URL;
        try {
            delete process.env.TEST_LATE_URL;
            const cap = captureUrl();
            const resolve = perServiceEnvResolver({ "x.v1.A": "TEST_LATE_URL" }, { createTransport: cap.createTransport });
            assert.equal(resolve({ typeName: "x.v1.A" }), null);
            process.env.TEST_LATE_URL = "http://late:1";
            assert.notEqual(resolve({ typeName: "x.v1.A" }), null);
            assert.equal(cap.url, "http://late:1");
        } finally {
            if (prev === undefined) delete process.env.TEST_LATE_URL;
            else process.env.TEST_LATE_URL = prev;
        }
    });
    it("builds a gRPC (HTTP/2) transport when no factory is given", async () => {
        const prev = process.env.TEST_GRPC_URL;
        try {
            const wire = await probeWire((baseUrl) => {
                process.env.TEST_GRPC_URL = baseUrl;
                return perServiceEnvResolver({ "echo.v1.EchoService": "TEST_GRPC_URL" })({ typeName: "echo.v1.EchoService" }) as Transport;
            });
            assert.match(wire.contentType ?? "", /^application\/grpc(\+proto)?$/);
            assert.equal(wire.code, Code.Unimplemented, "the client must read the gRPC trailers-only status");
        } finally {
            if (prev === undefined) delete process.env.TEST_GRPC_URL;
            else process.env.TEST_GRPC_URL = prev;
        }
    });
    it("treats a whitespace-only env var as unset (→ null)", () => {
        const prev = process.env.TEST_BLANK_URL;
        try {
            process.env.TEST_BLANK_URL = "   ";
            const resolve = perServiceEnvResolver({ "x.v1.A": "TEST_BLANK_URL" });
            assert.equal(resolve({ typeName: "x.v1.A" }), null);
        } finally {
            if (prev === undefined) delete process.env.TEST_BLANK_URL;
            else process.env.TEST_BLANK_URL = prev;
        }
    });
});
