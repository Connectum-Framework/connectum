/**
 * Descriptor pool edge cases that a served fixture cannot reach: import
 * graphs shaped as diamonds, files whose imports are absent, duplicate
 * declarations and hand-built descriptors.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { type FileDescriptorProto, FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { createDescriptorPool } from "../../src/descriptorPool.ts";

function file(init: MessageInitShape<typeof FileDescriptorProtoSchema>): FileDescriptorProto {
    return create(FileDescriptorProtoSchema, init);
}

function names(bytes: Uint8Array[]): string[] {
    return bytes.map((b) => fromBinary(FileDescriptorProtoSchema, b).name);
}

describe("createDescriptorPool", () => {
    // top imports left and right, both import base: base must be sent once.
    const diamond = [
        file({ name: "base.proto", package: "d" }),
        file({ name: "left.proto", package: "d", dependency: ["base.proto"] }),
        file({ name: "right.proto", package: "d", dependency: ["base.proto"] }),
        file({ name: "top.proto", package: "d", dependency: ["left.proto", "right.proto"] }),
    ];

    it("sends each file of a diamond-shaped import graph once, requested file first", () => {
        const pool = createDescriptorPool({ files: diamond, services: [] });
        const top = pool.fileByName("top.proto");
        assert.ok(top);
        assert.deepStrictEqual(names(pool.withDependencies(top, new Set())), ["top.proto", "left.proto", "right.proto", "base.proto"]);
    });

    it("always includes the requested file but skips imports already sent", () => {
        const pool = createDescriptorPool({ files: diamond, services: [] });
        const sent = new Set(["top.proto", "left.proto", "base.proto"]);
        const top = pool.fileByName("top.proto");
        assert.ok(top);
        assert.deepStrictEqual(names(pool.withDependencies(top, sent)), ["top.proto", "right.proto"]);
        assert.deepStrictEqual([...sent].sort(), ["base.proto", "left.proto", "right.proto", "top.proto"]);
    });

    it("skips an import that is not in the pool instead of failing the answer", () => {
        const pool = createDescriptorPool({ files: [file({ name: "a.proto", dependency: ["missing.proto"] })], services: [] });
        const a = pool.fileByName("a.proto");
        assert.ok(a);
        assert.deepStrictEqual(names(pool.withDependencies(a, new Set())), ["a.proto"]);
    });

    it("keeps the first of two files with the same name and the first declaration of a symbol", () => {
        const pool = createDescriptorPool({
            files: [
                file({ name: "a.proto", package: "p", messageType: [{ name: "M" }] }),
                file({ name: "a.proto", package: "other" }),
                file({ name: "b.proto", package: "p", messageType: [{ name: "M" }] }),
            ],
            services: [],
        });
        assert.strictEqual(pool.fileByName("a.proto")?.bytes.length, pool.fileContainingSymbol("p.M")?.bytes.length);
        assert.strictEqual(pool.fileContainingSymbol("p.M")?.name, "a.proto");
    });

    it("names declarations of a file without a package from the root scope", () => {
        const pool = createDescriptorPool({
            files: [
                file({
                    name: "root.proto",
                    messageType: [{ name: "M", field: [{ name: "f", number: 1 }] }],
                    enumType: [{ name: "E", value: [{ name: "E_ZERO", number: 0 }] }],
                    service: [{ name: "S", method: [{ name: "Call" }] }],
                }),
            ],
            services: ["S"],
        });
        for (const symbol of ["M", "M.f", "E", "E_ZERO", "S", "S.Call"]) {
            assert.strictEqual(pool.fileContainingSymbol(symbol)?.name, "root.proto", symbol);
        }
        assert.deepStrictEqual(pool.services, ["S"]);
    });

    it("indexes extensions whose extendee is written with or without a leading dot", () => {
        const pool = createDescriptorPool({
            files: [
                file({ name: "m.proto", package: "p", messageType: [{ name: "M" }] }),
                file({
                    name: "x.proto",
                    package: "p",
                    dependency: ["m.proto"],
                    extension: [
                        { name: "late", number: 120, extendee: ".p.M" },
                        { name: "early", number: 110, extendee: "p.M" },
                    ],
                }),
            ],
            services: [],
        });
        assert.deepStrictEqual(pool.extensionNumbersOf("p.M"), [110, 120]);
        assert.strictEqual(pool.fileContainingExtension("p.M", 110)?.name, "x.proto");
        assert.strictEqual(pool.fileContainingExtension("p.M", 111), undefined);
        assert.strictEqual(pool.extensionNumbersOf("p.Missing"), undefined);
    });
});
