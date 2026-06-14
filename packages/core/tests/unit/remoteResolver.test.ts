/**
 * RemoteResolver helpers unit tests — singleTransportResolver, mapResolver.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Transport } from "@connectrpc/connect";
import { mapResolver, singleTransportResolver } from "../../src/remoteResolver.ts";

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
