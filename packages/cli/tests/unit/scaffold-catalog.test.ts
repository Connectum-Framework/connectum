/**
 * Unit tests for the catalog / multi-service module fragment (task 2.7).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBufGenYaml } from "../../src/scaffold/bufConfig.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";

const catalogConfig: ScaffoldConfig = { name: "svc", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: { catalog: true } };

describe("generateBufGenYaml", () => {
    it("adds the catalog plugin with strategy: all when enabled", () => {
        const y = generateBufGenYaml(catalogConfig);
        assert.match(y, /protoc-gen-connectum-catalog/);
        assert.match(y, /strategy: all/);
    });
    it("is es-only when catalog is disabled", () => {
        const y = generateBufGenYaml({ ...catalogConfig, modules: {} });
        assert.match(y, /protoc-gen-es/);
        assert.doesNotMatch(y, /catalog/);
    });

    // Split into one chunk per `- local:` plugin entry, keyed by the plugin name.
    const pluginBlocks = (yaml: string): Map<string, string> =>
        new Map(
            yaml
                .split("  - local: ")
                .slice(1)
                .map((block) => [block.slice(0, block.indexOf("\n")), block]),
        );

    it("generates erasable enums with protoc-gen-es, with or without the catalog", () => {
        // A TypeScript `enum` in generated code breaks the scaffold's native `node` run
        // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) and its `erasableSyntaxOnly` typecheck (TS1294).
        for (const config of [catalogConfig, { ...catalogConfig, modules: {} }]) {
            const es = pluginBlocks(generateBufGenYaml(config)).get("protoc-gen-es") ?? "";
            assert.match(es, /\n {6}- erasable_syntax=true\n/);
            assert.match(es, /- target=ts/);
            assert.match(es, /- import_extension=\.ts/);
        }
    });

    it("never passes erasable_syntax to the catalog plugin, which rejects unknown options", () => {
        const catalog = pluginBlocks(generateBufGenYaml(catalogConfig)).get("protoc-gen-connectum-catalog") ?? "";
        assert.match(catalog, /strategy: all/);
        assert.doesNotMatch(catalog, /erasable_syntax/);
    });
});

describe("generateServer with catalog", () => {
    it("imports serviceCatalog and passes catalog to createServer", () => {
        const s = generateServer(catalogConfig);
        assert.match(s, /import \{ serviceCatalog \} from "#gen\/catalog\.gen\.ts"/);
        assert.match(s, /catalog: serviceCatalog,/);
    });
});

describe("transformBase with catalog", () => {
    const base = new Map<string, string>([
        ["package.json", JSON.stringify({ name: "@connectum/example-getting-started", dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: {} })],
        ["buf.gen.yaml", "version: v2\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
    ]);

    it("regenerates buf.gen.yaml with the catalog plugin and adds the dev dep", () => {
        const out = transformBase(base, catalogConfig);
        assert.match(out.get("buf.gen.yaml") ?? "", /protoc-gen-connectum-catalog/);
        const pkg = JSON.parse(out.get("package.json") ?? "{}");
        assert.equal(pkg.devDependencies["@connectum/protoc-gen-catalog"], "^1.2.0");
    });
});
