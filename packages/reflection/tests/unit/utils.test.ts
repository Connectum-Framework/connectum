import assert from "node:assert";
import { describe, it } from "node:test";
import { collectFileProtos } from "../../src/utils.ts";

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
        assert.strictEqual(result.length, 2);
    });

    it("should deduplicate files by name", () => {
        const mockFile = {
            name: "file1.proto",
            proto: { name: "file1.proto" },
            dependencies: [],
        };

        const result = collectFileProtos([mockFile, mockFile] as any);
        assert.strictEqual(result.length, 1);
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
        assert.strictEqual(result.length, 3); // shared, file1, file2
    });

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
        assert.strictEqual(result.length, 2);
        // B is visited first (depth-first from A → B), then A
        assert.strictEqual((result[0] as any).name, "b.proto");
        assert.strictEqual((result[1] as any).name, "a.proto");
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
        assert.strictEqual(result.length, 1);
        assert.strictEqual((result[0] as any).name, "self.proto");
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

    it("should return empty array for empty registry", () => {
        const result = collectFileProtos([] as any);
        assert.deepStrictEqual(result, []);
        assert.strictEqual(result.length, 0);
    });
});
