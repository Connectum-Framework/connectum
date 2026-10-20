import assert from "node:assert";
import { describe, it } from "node:test";
import { collectFileProtos } from "../../src/utils.ts";
import { file_fixture_v1_service } from "../fixtures/fixture/v1/service_pb.ts";

/**
 * Asserts that `actual` holds exactly the `expected` objects, in order, by
 * identity. Compared by identity on purpose: a failing deep comparison of
 * DescFile graphs with import cycles is extremely slow to report.
 */
function assertSameObjects(actual: readonly unknown[], expected: readonly unknown[]): void {
    assert.ok(
        actual.length === expected.length && expected.every((item, index) => actual[index] === item),
        `expected ${expected.length} specific descriptors in order, got ${actual.length}`,
    );
}

describe("collectFileProtos", () => {
    it("should return empty array for empty input", () => {
        const result = collectFileProtos([]);
        assert.deepStrictEqual(result, []);
    });

    it("should collect protos from files without dependencies", () => {
        // Create minimal DescFile-like objects for testing
        const mockFile1 = {
            name: "file1.proto",
            proto: { name: "file1.proto" },
            dependencies: [],
        };
        const mockFile2 = {
            name: "file2.proto",
            proto: { name: "file2.proto" },
            dependencies: [],
        };

        const result = collectFileProtos([mockFile1, mockFile2] as any);
        // The result holds the FileDescriptorProto of each file (what reflection
        // serializes), not the DescFile wrapper around it.
        assertSameObjects(result, [mockFile1.proto, mockFile2.proto]);
    });

    it("returns the real descriptors of a generated file and its imports, imports first", () => {
        // Import statements of fixture/v1/service.proto and fixture/v1/common.proto.
        const result = collectFileProtos([file_fixture_v1_service]);

        // By identity with a message, so that a failure does not try to print a whole descriptor graph.
        assert.ok(result.at(-1) === file_fixture_v1_service.proto, "the requested file's own descriptor comes last");
        assert.deepStrictEqual(
            new Set(result.map((proto) => proto.name)),
            new Set([
                "fixture/v1/service.proto",
                "fixture/v1/common.proto",
                "fixture/v1/legacy.proto",
                "fixture/v1/options.proto",
                "google/protobuf/empty.proto",
                "google/protobuf/timestamp.proto",
                "google/protobuf/descriptor.proto",
            ]),
        );
        assert.strictEqual(new Set(result.map((proto) => proto.name)).size, result.length, "each file once");
        const position = new Map(result.map((proto, index) => [proto.name, index]));
        for (const proto of result) {
            for (const dependency of proto.dependency) {
                assert.ok((position.get(dependency) ?? Infinity) < (position.get(proto.name) ?? -1), `${dependency} must precede ${proto.name}`);
            }
        }
    });

    it("should deduplicate files by name", () => {
        // Two distinct DescFile objects carrying the same file name: the same
        // file reached through two registries. Only the first one is kept.
        const first = {
            name: "file1.proto",
            proto: { name: "file1.proto", package: "first" },
            dependencies: [],
        };
        const second = {
            name: "file1.proto",
            proto: { name: "file1.proto", package: "second" },
            dependencies: [],
        };

        const result = collectFileProtos([first, second] as any);
        assertSameObjects(result, [first.proto]);
    });

    it("should deduplicate a dependency that is a different object with the same name", () => {
        const sharedViaFile1 = { name: "shared.proto", proto: { name: "shared.proto", package: "via1" }, dependencies: [] };
        const sharedViaFile2 = { name: "shared.proto", proto: { name: "shared.proto", package: "via2" }, dependencies: [] };
        const file1 = { name: "file1.proto", proto: { name: "file1.proto" }, dependencies: [sharedViaFile1] };
        const file2 = { name: "file2.proto", proto: { name: "file2.proto" }, dependencies: [sharedViaFile2] };

        const result = collectFileProtos([file1, file2] as any);
        assertSameObjects(result, [sharedViaFile1.proto, file1.proto, file2.proto]);
    });

    it("should visit dependencies before the file itself (depth-first)", () => {
        const depFile = {
            name: "dep.proto",
            proto: { name: "dep.proto" },
            dependencies: [],
        };
        const mainFile = {
            name: "main.proto",
            proto: { name: "main.proto" },
            dependencies: [depFile],
        };

        const result = collectFileProtos([mainFile] as any);
        assert.strictEqual(result.length, 2);
        // Dependency should come before the main file
        assert.strictEqual((result[0] as any).name, "dep.proto");
        assert.strictEqual((result[1] as any).name, "main.proto");
    });

    it("should handle transitive dependencies", () => {
        const dep2 = {
            name: "dep2.proto",
            proto: { name: "dep2.proto" },
            dependencies: [],
        };
        const dep1 = {
            name: "dep1.proto",
            proto: { name: "dep1.proto" },
            dependencies: [dep2],
        };
        const mainFile = {
            name: "main.proto",
            proto: { name: "main.proto" },
            dependencies: [dep1],
        };

        const result = collectFileProtos([mainFile] as any);
        assert.strictEqual(result.length, 3);
        // dep2 -> dep1 -> main
        assert.strictEqual((result[0] as any).name, "dep2.proto");
        assert.strictEqual((result[1] as any).name, "dep1.proto");
        assert.strictEqual((result[2] as any).name, "main.proto");
    });

    it("should handle diamond dependencies without duplicates", () => {
        const sharedDep = {
            name: "shared.proto",
            proto: { name: "shared.proto" },
            dependencies: [],
        };
        const file1 = {
            name: "file1.proto",
            proto: { name: "file1.proto" },
            dependencies: [sharedDep],
        };
        const file2 = {
            name: "file2.proto",
            proto: { name: "file2.proto" },
            dependencies: [sharedDep],
        };

        const result = collectFileProtos([file1, file2] as any);
        // The shared import comes once, ahead of both files that import it.
        assertSameObjects(result, [sharedDep.proto, file1.proto, file2.proto]);
    });

    // Import cycles and self-imports cannot come from a valid schema: `buf build`
    // rejects them ("detected cyclic import") and protobuf-es refuses to build a
    // file registry from them ("Cannot find ..., imported by ..."). The two cases
    // below guard the traversal against a hand-built DescFile graph: marking a
    // file as visited only after its imports would overflow the stack.
    it("should handle circular dependencies without infinite loop", () => {
        const fileA: any = {
            name: "a.proto",
            proto: { name: "a.proto" },
            dependencies: [],
        };
        const fileB: any = {
            name: "b.proto",
            proto: { name: "b.proto" },
            dependencies: [fileA],
        };
        // Create circular: A depends on B, B depends on A
        fileA.dependencies = [fileB];

        const result = collectFileProtos([fileA] as any);
        // B is visited first (depth-first from A → B), then A; each exactly once.
        assertSameObjects(result, [fileB.proto, fileA.proto]);
    });

    it("should handle self-referencing dependency without infinite loop", () => {
        const selfRef: any = {
            name: "self.proto",
            proto: { name: "self.proto" },
            dependencies: [],
        };
        // File depends on itself
        selfRef.dependencies = [selfRef];

        const result = collectFileProtos([selfRef] as any);
        assertSameObjects(result, [selfRef.proto]);
    });

    it("should collect all files in depth-first order for fan-out dependencies", () => {
        const dep1 = {
            name: "dep1.proto",
            proto: { name: "dep1.proto" },
            dependencies: [],
        };
        const dep2 = {
            name: "dep2.proto",
            proto: { name: "dep2.proto" },
            dependencies: [],
        };
        const dep3 = {
            name: "dep3.proto",
            proto: { name: "dep3.proto" },
            dependencies: [],
        };
        const mainFile = {
            name: "main.proto",
            proto: { name: "main.proto" },
            dependencies: [dep1, dep2, dep3],
        };

        const result = collectFileProtos([mainFile] as any);
        assert.strictEqual(result.length, 4);
        // Dependencies visited depth-first before main
        assert.strictEqual((result[0] as any).name, "dep1.proto");
        assert.strictEqual((result[1] as any).name, "dep2.proto");
        assert.strictEqual((result[2] as any).name, "dep3.proto");
        assert.strictEqual((result[3] as any).name, "main.proto");
    });
});
