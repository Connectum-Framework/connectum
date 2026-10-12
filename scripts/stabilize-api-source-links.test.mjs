import assert from "node:assert/strict";
import { test } from "node:test";
import { stabilizeSourceLinks } from "./stabilize-api-source-links.mjs";

const tracked = new Set([
    "packages/cli/src/commands/proto-sync.ts",
    "packages/core/src/Server.ts",
    "packages/core/src/types.ts",
    "packages/reflection/src/Reflection.ts",
    "packages/reflection/tests/fixtures/fixture/v1/options_pb.ts",
    "packages/test-fixtures/src/assertions.ts",
    "packages/testing/src/types.ts",
]);

test("tracked TypeDoc definitions become stable source links", () => {
    const input = [
        "Defined in: packages/core/src/Server.ts:657",
        "  Defined in: packages/core/src/types.ts:12",
    ].join("\n");

    assert.equal(
        stabilizeSourceLinks(input, tracked),
        [
            "Defined in: [packages/core/src/Server.ts:657](https://github.com/Connectum-Framework/connectum/blob/main/packages/core/src/Server.ts#L657)",
            "  Defined in: [packages/core/src/types.ts:12](https://github.com/Connectum-Framework/connectum/blob/main/packages/core/src/types.ts#L12)",
        ].join("\n"),
    );
});

test("package-relative TypeDoc definitions resolve under their API owner", () => {
    assert.equal(
        stabilizeSourceLinks("Defined in: commands/proto-sync.ts:124", tracked, "cli"),
        "Defined in: [commands/proto-sync.ts:124](https://github.com/Connectum-Framework/connectum/blob/main/packages/cli/src/commands/proto-sync.ts#L124)",
    );
    assert.equal(
        stabilizeSourceLinks("Defined in: Reflection.ts:50", tracked, "reflection"),
        "Defined in: [Reflection.ts:50](https://github.com/Connectum-Framework/connectum/blob/main/packages/reflection/src/Reflection.ts#L50)",
    );
    assert.equal(
        stabilizeSourceLinks("Defined in: testing/src/types.ts:38", tracked, "testing"),
        "Defined in: [testing/src/types.ts:38](https://github.com/Connectum-Framework/connectum/blob/main/packages/testing/src/types.ts#L38)",
    );
    assert.equal(
        stabilizeSourceLinks("Defined in: src/Server.ts:657", tracked, "core"),
        "Defined in: [src/Server.ts:657](https://github.com/Connectum-Framework/connectum/blob/main/packages/core/src/Server.ts#L657)",
    );
    assert.equal(
        stabilizeSourceLinks("Defined in: packages/reflection/tests/fixtures/fixture/v1/options\\_pb.ts:14", tracked),
        "Defined in: [packages/reflection/tests/fixtures/fixture/v1/options\\_pb.ts:14](https://github.com/Connectum-Framework/connectum/blob/main/packages/reflection/tests/fixtures/fixture/v1/options_pb.ts#L14)",
    );
});

test("relative names are never resolved by basename across package owners", () => {
    const input = "Defined in: commands/proto-sync.ts:124";

    assert.equal(stabilizeSourceLinks(input, tracked, "core"), input);
    assert.equal(stabilizeSourceLinks("Defined in: assertions.ts:1", tracked, "testing"), "Defined in: assertions.ts:1");
});

test("untracked and non-TypeDoc source-looking paths remain unchanged", () => {
    const input = [
        "Defined in: packages/core/src/generated.ts:9",
        "Defined in: packages/events/dist/index.d.ts:1",
        "Defined in: test-fixtures/dist/index.d.ts:1",
        "Defined in: generated.ts:9",
        "Defined in: node_modules/typescript/lib/lib.es5.d.ts:12",
        "Source hint: packages/core/src/Server.ts:657",
    ].join("\n");

    assert.equal(stabilizeSourceLinks(input, tracked), input);
});

test("fenced source references stay untouched while existing SHA links are stabilized", () => {
    const input = [
        "```text",
        "Defined in: packages/core/src/Server.ts:657",
        "https://github.com/Connectum-Framework/connectum/blob/0123456789abcdef0123456789abcdef01234567/packages/core/src/Server.ts#L657",
        "```",
        "~~~ts",
        "Defined in: packages/core/src/types.ts:12",
        "~~~",
    ].join("\n");

    const expected = input.replace(
        "blob/0123456789abcdef0123456789abcdef01234567/",
        "blob/main/",
    );
    assert.equal(stabilizeSourceLinks(input, tracked), expected);
});

test("existing linked SHA references stay stable and the rewrite is idempotent", () => {
    const input = "[Server.ts](https://github.com/Connectum-Framework/connectum/blob/0123456789abcdef0123456789abcdef01234567/packages/core/src/Server.ts#L657)";
    const expected = "[Server.ts](https://github.com/Connectum-Framework/connectum/blob/main/packages/core/src/Server.ts#L657)";

    const first = stabilizeSourceLinks(input, tracked);
    assert.equal(first, expected);
    assert.equal(stabilizeSourceLinks(first, tracked), expected);
});

test("tracked full and package-relative definitions are idempotent", () => {
    for (const [input, packageName] of [
        ["Defined in: packages/core/src/Server.ts:657", null],
        ["Defined in: commands/proto-sync.ts:124", "cli"],
    ]) {
        const first = stabilizeSourceLinks(input, tracked, packageName);
        assert.notEqual(first, input);
        assert.equal(stabilizeSourceLinks(first, tracked, packageName), first);
    }
});

test("relative traversal, absolute paths, and untracked dist paths stay unlinked", () => {
    for (const [input, packageName] of [
        ["Defined in: ../core/src/Server.ts:657", "cli"],
        ["Defined in: /packages/core/src/Server.ts:657", "core"],
        ["Defined in: test-fixtures/dist/index.d.ts:1", "testing"],
    ]) {
        assert.equal(stabilizeSourceLinks(input, tracked, packageName), input);
    }
});

test("source-like prose that is not a standalone TypeDoc line stays unchanged", () => {
    const input = "The old generator printed Defined in: packages/core/src/Server.ts:657 beside this symbol.";

    assert.equal(stabilizeSourceLinks(input, tracked, "core"), input);
});
