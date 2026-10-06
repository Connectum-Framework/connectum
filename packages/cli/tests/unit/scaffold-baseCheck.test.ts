/**
 * The fetched base is checked before it is transformed: an unfit base (a different `--ref`,
 * a damaged download) must end in one message listing every defect, never in a raw
 * runtime error from the middle of the transform.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertFitBase, findBaseDefects } from "../../src/scaffold/baseCheck.ts";
import { baseFiles } from "../helpers/baseFixture.ts";

const withPackageJson = (mutate: (pkg: Record<string, unknown>) => void): Map<string, string> => {
    const files = baseFiles();
    const pkg = JSON.parse(files.get("package.json") ?? "{}") as Record<string, unknown>;
    mutate(pkg);
    files.set("package.json", JSON.stringify(pkg));
    return files;
};

describe("findBaseDefects", () => {
    it("finds nothing in a fit base, with or without the sample", () => {
        assert.deepEqual(findBaseDefects(baseFiles(), { sample: true }), []);
        assert.deepEqual(findBaseDefects(baseFiles(), { sample: false }), []);
    });

    it("reports an empty base", () => {
        assert.deepEqual(findBaseDefects(new Map(), { sample: true }), ["the base contains no files"]);
    });

    it("reports a missing package.json", () => {
        const files = baseFiles();
        files.delete("package.json");
        assert.deepEqual(findBaseDefects(files, { sample: false }), ["package.json is missing"]);
    });

    it("reports an unparsable package.json with the parser's reason", () => {
        const files = baseFiles();
        files.set("package.json", "{ not json");
        const defects = findBaseDefects(files, { sample: false });
        assert.equal(defects.length, 1);
        assert.match(defects[0] ?? "", /^package\.json is not valid JSON: /);
    });

    it("reports a package.json that is not an object", () => {
        for (const raw of ["[]", "null", "42", '"text"']) {
            const files = baseFiles();
            files.set("package.json", raw);
            assert.deepEqual(findBaseDefects(files, { sample: false }), ["package.json must contain a JSON object"]);
        }
    });

    it("reports dependency sections that are not objects", () => {
        const files = withPackageJson((pkg) => {
            pkg.dependencies = ["@connectum/core"];
            pkg.devDependencies = "typescript";
        });
        assert.deepEqual(findBaseDefects(files, { sample: false }), ['package.json "dependencies" must be an object', 'package.json "devDependencies" must be an object']);
    });

    it("accepts a base without any dependency section", () => {
        const files = withPackageJson((pkg) => {
            delete pkg.dependencies;
            delete pkg.devDependencies;
        });
        assert.deepEqual(findBaseDefects(files, { sample: false }), []);
    });

    it("reports missing import aliases the generated code relies on", () => {
        const files = withPackageJson((pkg) => {
            pkg.imports = { "#*": "./src/*" };
        });
        assert.deepEqual(findBaseDefects(files, { sample: false }), ['package.json "imports" has no "#gen/*" alias, which the generated code imports through']);
        const none = withPackageJson((pkg) => {
            delete pkg.imports;
        });
        assert.deepEqual(findBaseDefects(none, { sample: false }), ['package.json has no "imports" aliases "#gen/*" and "#*", which the generated code imports through']);
    });

    it("reports a missing tsconfig.json", () => {
        const files = baseFiles();
        files.delete("tsconfig.json");
        assert.deepEqual(findBaseDefects(files, { sample: false }), ["tsconfig.json is missing (the generated `typecheck` script runs `tsc`)"]);
    });

    it("requires the sample files only when the sample is wanted", () => {
        const files = baseFiles();
        files.delete("proto/greeter/v1/greeter.proto");
        files.delete("src/services/greeterService.ts");
        assert.deepEqual(findBaseDefects(files, { sample: false }), []);
        assert.deepEqual(findBaseDefects(files, { sample: true }), ["proto/greeter/v1/greeter.proto is missing", "src/services/greeterService.ts is missing"]);
    });

    it("reports a sample proto that lacks the service or its methods", () => {
        const files = baseFiles();
        files.set("proto/greeter/v1/greeter.proto", 'syntax = "proto3";\npackage greeter.v1;\nservice GreeterService { rpc SayHello(A) returns (B); }\n');
        assert.deepEqual(findBaseDefects(files, { sample: true }), ["proto/greeter/v1/greeter.proto declares no `rpc SayGoodbye`, which the generated end-to-end test calls"]);
        files.set("proto/greeter/v1/greeter.proto", 'syntax = "proto3";\npackage other.v1;\nservice Other { rpc Ping(A) returns (B); }\n');
        assert.deepEqual(findBaseDefects(files, { sample: true }), [
            "proto/greeter/v1/greeter.proto declares no `service GreeterService`, which the generated server registers",
            "proto/greeter/v1/greeter.proto declares no `rpc SayHello`, which the generated end-to-end test calls",
            "proto/greeter/v1/greeter.proto declares no `rpc SayGoodbye`, which the generated end-to-end test calls",
        ]);
    });

    it("reports every defect together, in a fixed order", () => {
        const broken = withPackageJson((pkg) => {
            pkg.imports = {};
        });
        broken.delete("tsconfig.json");
        broken.delete("proto/greeter/v1/greeter.proto");
        assert.deepEqual(findBaseDefects(broken, { sample: true }), [
            'package.json "imports" has no "#gen/*" alias, which the generated code imports through',
            'package.json "imports" has no "#*" alias, which the generated code imports through',
            "tsconfig.json is missing (the generated `typecheck` script runs `tsc`)",
            "proto/greeter/v1/greeter.proto is missing",
        ]);
    });
});

describe("assertFitBase", () => {
    it("does nothing for a fit base", () => {
        assert.doesNotThrow(() => assertFitBase(baseFiles(), { sample: true }));
    });

    it("throws one message that lists every defect and names the ref", () => {
        const files = baseFiles();
        files.delete("tsconfig.json");
        files.delete("package.json");
        assert.throws(
            () => assertFitBase(files, { sample: true }, "feature-x"),
            (err: Error) =>
                err.message.startsWith('connectum init: the base project fetched from "feature-x" cannot be used:') &&
                err.message.includes("package.json is missing") &&
                err.message.includes("tsconfig.json is missing"),
        );
    });
});
