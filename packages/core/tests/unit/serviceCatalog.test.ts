/**
 * serviceCatalog() unit tests
 *
 * Covers the catalog primitives: defineCatalog (freeze + literal preservation)
 * and mergeCatalogs (composition + mandatory duplicate-typeName throw).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescService } from "@bufbuild/protobuf";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
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
        const descriptor = svc("x.A");
        const input: Record<string, DescService> = { "x.A": descriptor };
        const catalog = defineCatalog(input);

        assert.notEqual(catalog, input, "should return a copy, not the same reference");
        // The caller keeps a usable record: it is not frozen or sealed, and still
        // accepts new entries without those leaking into the catalog.
        assert.equal(Object.isFrozen(input), false, "the input record must not be frozen");
        input["x.B"] = svc("x.B");
        assert.deepEqual(Object.keys(input), ["x.A", "x.B"]);
        assert.deepEqual(Object.keys(catalog), ["x.A"], "later edits of the input must not reach the catalog");
        assert.equal(catalog["x.A"], descriptor, "the descriptor itself is kept, not cloned");
    });

    it("throws a CatalogConfigError when a key does not match its descriptor typeName", () => {
        assert.throws(
            () => defineCatalog({ "wrong.key": svc("x.A") }),
            (err: unknown) => err instanceof CatalogConfigError && err.name === "CatalogConfigError" && /key "wrong\.key" must match descriptor\.typeName "x\.A"/.test(err.message),
        );
    });

    it("rejects a mismatched entry that sits after valid ones", () => {
        assert.throws(
            () => defineCatalog({ "x.A": svc("x.A"), "x.B": svc("x.B"), "x.C": svc("x.other") }),
            (err: unknown) => err instanceof CatalogConfigError && /key "x\.C" must match descriptor\.typeName "x\.other"/.test(err.message),
        );
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

    it("throws a CatalogConfigError on a duplicate typeName across catalogs", () => {
        const a: ServiceCatalog = { "x.A": svc("x.A") };
        const b: ServiceCatalog = { "x.A": svc("x.A") };
        assert.throws(
            () => mergeCatalogs(a, b),
            (err: unknown) => err instanceof CatalogConfigError && err.name === "CatalogConfigError" && /duplicate typeName: "x\.A"/.test(err.message),
        );
    });

    it("finds a duplicate that is not in the first two catalogs", () => {
        const a: ServiceCatalog = { "x.A": svc("x.A") };
        const b: ServiceCatalog = { "x.B": svc("x.B") };
        const c: ServiceCatalog = { "x.A": svc("x.A") };
        assert.throws(
            () => mergeCatalogs(a, b, c),
            (err: unknown) => err instanceof CatalogConfigError && /duplicate typeName: "x\.A"/.test(err.message),
        );
    });

    it("does not mistake a typeName that names an Object.prototype member for a duplicate", () => {
        const merged = mergeCatalogs({ toString: svc("toString") }, { constructor: svc("constructor") });
        assert.deepEqual(Object.keys(merged).sort(), ["constructor", "toString"]);
    });

    it("returns an empty frozen catalog for no arguments", () => {
        const merged = mergeCatalogs();
        assert.deepEqual(Object.keys(merged), []);
        assert.equal(Object.isFrozen(merged), true);
    });

    it("throws a CatalogConfigError when a key does not match its descriptor typeName", () => {
        const bad: ServiceCatalog = { "wrong.key": svc("x.A") };
        assert.throws(
            () => mergeCatalogs(bad),
            (err: unknown) => err instanceof CatalogConfigError && err.name === "CatalogConfigError" && /key "wrong\.key" must match descriptor\.typeName "x\.A"/.test(err.message),
        );
    });

    it("rejects a mismatched entry in a later catalog", () => {
        const ok: ServiceCatalog = { "x.A": svc("x.A") };
        const bad: ServiceCatalog = { "wrong.key": svc("x.B") };
        assert.throws(
            () => mergeCatalogs(ok, bad),
            (err: unknown) => err instanceof CatalogConfigError && /key "wrong\.key" must match descriptor\.typeName "x\.B"/.test(err.message),
        );
    });

    it("does not modify the catalogs it merges", () => {
        const a: ServiceCatalog = Object.freeze({ "x.A": svc("x.A") });
        const b: ServiceCatalog = { "x.B": svc("x.B") };
        const merged = mergeCatalogs(a, b);

        assert.deepEqual(Object.keys(a), ["x.A"]);
        assert.deepEqual(Object.keys(b), ["x.B"]);
        assert.equal(Object.isFrozen(b), false, "an input catalog must not be frozen by the merge");
        assert.notEqual(merged, a);
        assert.notEqual(merged, b);
    });
});
