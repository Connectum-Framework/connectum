/**
 * serviceCatalog() unit tests
 *
 * Covers the catalog primitives: defineCatalog (freeze + literal preservation)
 * and mergeCatalogs (composition + mandatory duplicate-typeName throw).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescService } from "@bufbuild/protobuf";
import { defineCatalog, mergeCatalogs, type ServiceCatalog } from "../../src/serviceCatalog.ts";

// Minimal DescService stand-ins — only `typeName` matters for catalog identity.
const svc = (typeName: string): DescService => ({ typeName }) as unknown as DescService;

describe("defineCatalog", () => {
    it("returns a frozen catalog", () => {
        const catalog = defineCatalog({ "x.A": svc("x.A") });
        assert.equal(Object.isFrozen(catalog), true);
    });

    it("preserves all entries", () => {
        const catalog = defineCatalog({ "x.A": svc("x.A"), "x.B": svc("x.B") });
        assert.deepEqual(Object.keys(catalog).sort(), ["x.A", "x.B"]);
    });

    it("does not mutate the input record", () => {
        const input = { "x.A": svc("x.A") };
        const catalog = defineCatalog(input);
        assert.notEqual(catalog, input, "should return a copy, not the same reference");
    });
});

describe("mergeCatalogs", () => {
    it("merges disjoint catalogs", () => {
        const a: ServiceCatalog = { "x.A": svc("x.A") };
        const b: ServiceCatalog = { "x.B": svc("x.B"), "x.C": svc("x.C") };
        const merged = mergeCatalogs(a, b);
        assert.deepEqual(Object.keys(merged).sort(), ["x.A", "x.B", "x.C"]);
        assert.equal(Object.isFrozen(merged), true);
    });

    it("throws on a duplicate typeName across catalogs", () => {
        const a: ServiceCatalog = { "x.A": svc("x.A") };
        const b: ServiceCatalog = { "x.A": svc("x.A") };
        assert.throws(() => mergeCatalogs(a, b), /duplicate typeName: "x\.A"/);
    });

    it("returns an empty frozen catalog for no arguments", () => {
        const merged = mergeCatalogs();
        assert.deepEqual(Object.keys(merged), []);
        assert.equal(Object.isFrozen(merged), true);
    });
});
