/**
 * Unit tests for the scaffold version floors.
 *
 * The floors are what keeps `connectum init --ref <older base>` from producing a
 * manifest that allows protobuf-es versions its own generated code cannot use (erasable
 * enums need protoc-gen-es >= 2.13.0 and import `UnknownEnum`, which @bufbuild/protobuf
 * exports since 2.13.0). An end-to-end scaffold cannot catch a lost floor, because an
 * install resolves the highest version in range; these tests can.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyVersionFloors, meetsFloor, SCAFFOLD_VERSION_FLOORS } from "../../src/scaffold/versionFloors.ts";

describe("SCAFFOLD_VERSION_FLOORS", () => {
    it("floors the protobuf-es runtime and generator at 2.16.0 in their manifest sections", () => {
        assert.deepEqual(
            [...SCAFFOLD_VERSION_FLOORS].map((f) => [f.section, f.name, f.version]),
            [
                ["dependencies", "@bufbuild/protobuf", "2.16.0"],
                ["devDependencies", "@bufbuild/protoc-gen-es", "2.16.0"],
            ],
        );
    });
});

describe("meetsFloor", () => {
    it("reads caret, tilde and exact ranges by their lower bound", () => {
        assert.equal(meetsFloor("^2.16.0", "2.16.0"), true);
        assert.equal(meetsFloor("~2.17.1", "2.16.0"), true);
        assert.equal(meetsFloor("2.16.0", "2.16.0"), true);
        assert.equal(meetsFloor("^3.0.0", "2.16.0"), true);
        assert.equal(meetsFloor("^2.16.10", "2.16.2"), true, "numeric, not lexical, comparison");
    });

    it("rejects ranges that start below the floor", () => {
        assert.equal(meetsFloor("^2.11.0", "2.16.0"), false);
        assert.equal(meetsFloor("^2.15.9", "2.16.0"), false);
        assert.equal(meetsFloor("^1.99.99", "2.16.0"), false);
    });

    it("treats a missing or unreadable range as not meeting the floor", () => {
        assert.equal(meetsFloor(undefined, "2.16.0"), false);
        assert.equal(meetsFloor(">=2.16.0", "2.16.0"), false);
        assert.equal(meetsFloor("latest", "2.16.0"), false);
        assert.equal(meetsFloor("*", "2.16.0"), false);
        assert.equal(meetsFloor("^2.16.0-rc.1", "2.16.0"), false);
    });

    it("refuses a floor that is not major.minor.patch (a typo in the table must not pass silently)", () => {
        assert.throws(() => meetsFloor("^2.16.0", "2.16"), /not a major\.minor\.patch version/);
    });
});

describe("applyVersionFloors", () => {
    it("raises a base range below the floor (an older base picked with --ref)", () => {
        assert.deepEqual(applyVersionFloors("dependencies", { "@bufbuild/protobuf": "^2.11.0", "@connectum/core": "^1.0.0" }), {
            "@bufbuild/protobuf": "^2.16.0",
            "@connectum/core": "^1.0.0",
        });
        assert.deepEqual(applyVersionFloors("devDependencies", { "@bufbuild/protoc-gen-es": "^2.11.0" }), { "@bufbuild/protoc-gen-es": "^2.16.0" });
    });

    it("keeps a base range already at or above the floor, so a newer base is never pulled down", () => {
        assert.deepEqual(applyVersionFloors("dependencies", { "@bufbuild/protobuf": "^2.17.3" }), { "@bufbuild/protobuf": "^2.17.3" });
        assert.deepEqual(applyVersionFloors("devDependencies", { "@bufbuild/protoc-gen-es": "~2.16.1" }), { "@bufbuild/protoc-gen-es": "~2.16.1" });
    });

    it("adds a floored package the base does not declare", () => {
        assert.deepEqual(applyVersionFloors("dependencies", {}), { "@bufbuild/protobuf": "^2.16.0" });
        assert.deepEqual(applyVersionFloors("devDependencies", { typescript: "^5.9.3" }), { typescript: "^5.9.3", "@bufbuild/protoc-gen-es": "^2.16.0" });
    });

    it("replaces a range it cannot read with the floor", () => {
        assert.deepEqual(applyVersionFloors("dependencies", { "@bufbuild/protobuf": "latest" }), { "@bufbuild/protobuf": "^2.16.0" });
    });

    it("applies only the floors of the given section", () => {
        // The generator is a devDependency: it must not leak into `dependencies`, and the
        // runtime must not be duplicated into `devDependencies`.
        assert.equal(applyVersionFloors("dependencies", {})["@bufbuild/protoc-gen-es"], undefined);
        assert.equal(applyVersionFloors("devDependencies", {})["@bufbuild/protobuf"], undefined);
    });

    it("does not mutate its input", () => {
        const deps = { "@bufbuild/protobuf": "^2.11.0" };
        applyVersionFloors("dependencies", deps);
        assert.deepEqual(deps, { "@bufbuild/protobuf": "^2.11.0" });
    });
});
