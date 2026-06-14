/**
 * RemoteResolver helpers unit tests — singleTransportResolver, mapResolver.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Transport } from "@connectrpc/connect";
import { dnsResolver, mapResolver, perServiceEnvResolver, singleTransportResolver } from "../../src/remoteResolver.ts";

// Opaque Transport stand-ins — identity is all the resolvers need.
const tA = { id: "A" } as unknown as Transport;
const tB = { id: "B" } as unknown as Transport;

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
    it("always resolves (never null)", () => {
        const resolve = dnsResolver({ template: "http://{shortName}", createTransport: (u: string) => ({ id: u }) as unknown as Transport });
        assert.notEqual(resolve({ typeName: "x.v1.A" }), null);
    });
});

describe("perServiceEnvResolver", () => {
    it("resolves a mapped service whose env var is set", () => {
        process.env.TEST_ORDERS_URL = "http://orders:5000";
        const cap = captureUrl();
        const resolve = perServiceEnvResolver({ "orders.v1.OrdersService": "TEST_ORDERS_URL" }, { createTransport: cap.createTransport });
        const t = resolve({ typeName: "orders.v1.OrdersService" });
        assert.notEqual(t, null);
        assert.equal(cap.url, "http://orders:5000");
        delete process.env.TEST_ORDERS_URL;
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
});
