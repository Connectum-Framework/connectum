/**
 * Unit tests for the `connectum init` base transform (pure, no network).
 *
 * Validates config resolution, script/devDep synthesis (lifecycle-fix,
 * package-manager independence, runtime variance), the in-process e2e test
 * generation (D-7), and the whole-tree transform.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveConfig } from "../../src/scaffold/config.ts";
import {
    buildDevDeps,
    buildScripts,
    generateGreeterE2eTest,
    transformBase,
    transformPackageJson,
} from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";

const nodePnpm: ScaffoldConfig = { name: "payments", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: {} };

describe("resolveConfig", () => {
    it("applies defaults", () => {
        const cfg = resolveConfig({ name: "svc" });
        assert.deepEqual(cfg, {
            name: "svc",
            runtime: "node",
            packageManager: "pnpm",
            nodeExec: "raw",
            sample: true,
            modules: { otel: false, events: undefined, auth: false, resilience: [], healthcheck: true, reflection: true, catalog: false },
        });
    });

    it("requires a name", () => {
        assert.throws(() => resolveConfig({}), /project name is required/);
        assert.throws(() => resolveConfig({ name: "  " }), /project name is required/);
    });

    it("rejects invalid enum values", () => {
        assert.throws(() => resolveConfig({ name: "x", runtime: "deno" }), /invalid --runtime/);
        assert.throws(() => resolveConfig({ name: "x", packageManager: "yarn" }), /invalid --package-manager/);
        assert.throws(() => resolveConfig({ name: "x", nodeExec: "swc" }), /invalid --node-exec/);
    });
});

describe("buildScripts", () => {
    it("bakes the lifecycle-fix into typecheck/test/start (not pnpm pre* hooks)", () => {
        const s = buildScripts(nodePnpm);
        assert.ok(s.typecheck.startsWith("buf generate &&"));
        assert.ok(s.test.startsWith("buf generate &&"));
        assert.ok(s.start.startsWith("buf generate &&"));
    });

    it("keeps build:proto package-manager-independent (no `pnpm run`)", () => {
        const s = buildScripts({ ...nodePnpm, packageManager: "npm" });
        assert.equal(s["build:proto"], "buf generate");
        assert.ok(!s["build:proto"].includes("pnpm"));
    });

    it("targets node with node --test by default", () => {
        assert.match(buildScripts(nodePnpm).test, /node --test/);
        assert.match(buildScripts(nodePnpm).start, /node src\/index\.ts/);
    });

    it("targets bun with bun test", () => {
        const s = buildScripts({ ...nodePnpm, runtime: "bun" });
        assert.match(s.test, /bun test/);
        assert.match(s.start, /bun src\/index\.ts/);
    });

    it("uses tsx under the node tsx model", () => {
        const s = buildScripts({ ...nodePnpm, nodeExec: "tsx" });
        assert.match(s.start, /tsx src\/index\.ts/);
        assert.match(s.test, /--import tsx/);
    });
});

describe("buildDevDeps", () => {
    const existing = {
        "@bufbuild/buf": "^1.65.0",
        "@bufbuild/protoc-gen-es": "^2.11.0",
        "@connectrpc/connect-node": "^2.1.1",
        "@types/node": "^25.2.0",
        tsx: "^4.21.0",
        typescript: "^5.9.3",
    };

    it("adds @connectum/testing and drops @connectrpc/connect-node", () => {
        const d = buildDevDeps(existing, nodePnpm, "^1.0.0");
        assert.equal(d["@connectum/testing"], "^1.0.0");
        assert.equal(d["@connectrpc/connect-node"], undefined);
    });

    it("keeps tsx only under the node tsx model", () => {
        assert.equal(buildDevDeps(existing, nodePnpm, "^1.0.0").tsx, undefined);
        assert.equal(buildDevDeps(existing, { ...nodePnpm, nodeExec: "tsx" }, "^1.0.0").tsx, "^4.21.0");
        assert.equal(buildDevDeps(existing, { ...nodePnpm, runtime: "bun" }, "^1.0.0").tsx, undefined);
    });
});

describe("transformPackageJson", () => {
    const raw = JSON.stringify(
        {
            name: "@connectum/example-getting-started",
            private: true,
            type: "module",
            imports: { "#gen/*": "./gen/*", "#*": "./src/*" },
            scripts: { start: "node src/index.ts" },
            dependencies: { "@connectum/core": "^1.2.0", "@connectrpc/connect": "^2.1.1" },
            devDependencies: { "@bufbuild/buf": "^1.65.0", "@connectrpc/connect-node": "^2.1.1", typescript: "^5.9.3" },
            engines: { node: ">=25.2.0" },
        },
        null,
        2,
    );

    it("sets name, removes private, keeps imports and deps", () => {
        const pkg = JSON.parse(transformPackageJson(raw, nodePnpm));
        assert.equal(pkg.name, "payments");
        assert.equal(pkg.private, undefined);
        assert.deepEqual(pkg.imports, { "#gen/*": "./gen/*", "#*": "./src/*" });
        assert.equal(pkg.dependencies["@connectum/core"], "^1.2.0");
    });

    it("pins @connectum/testing to the same slice as @connectum/core", () => {
        const pkg = JSON.parse(transformPackageJson(raw, nodePnpm));
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.2.0");
    });

    it("sets the node engine floor per exec model", () => {
        assert.equal(JSON.parse(transformPackageJson(raw, nodePnpm)).engines.node, ">=25.2.0");
        assert.equal(JSON.parse(transformPackageJson(raw, { ...nodePnpm, nodeExec: "tsx" })).engines.node, ">=22.13.0");
    });
});

describe("generateGreeterE2eTest", () => {
    it("uses the in-process createLocalClient and node:test on Node", () => {
        const t = generateGreeterE2eTest("node");
        assert.match(t, /from "node:test"/);
        assert.match(t, /createLocalClient/);
        assert.match(t, /createServer\(\{ services: \[greeterService\] \}\)/);
        assert.doesNotMatch(t, /createGrpcTransport/);
    });

    it("uses bun:test on Bun (same body)", () => {
        const t = generateGreeterE2eTest("bun");
        assert.match(t, /from "bun:test"/);
        assert.match(t, /createLocalClient/);
    });
});

describe("transformBase", () => {
    const base = new Map<string, string>([
        [
            "package.json",
            JSON.stringify({ name: "@connectum/example-getting-started", private: true, dependencies: { "@connectum/core": "^1.0.0" }, devDependencies: { "@connectrpc/connect-node": "^2.1.1" } }, null, 2),
        ],
        ["pnpm-workspace.yaml", "packages: []\n"],
        ["tests/e2e/e2e.test.ts", "// old test using createGrpcTransport\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ["buf.gen.yaml", "version: v2\n"],
    ]);

    it("replaces the monorepo pnpm-workspace.yaml and regenerates the e2e test", () => {
        const out = transformBase(base, nodePnpm);
        // The monorepo workspace file ("packages: []") is replaced by a standalone one.
        assert.doesNotMatch(out.get("pnpm-workspace.yaml") ?? "", /packages:/);
        assert.match(out.get("tests/e2e/e2e.test.ts") ?? "", /createLocalClient/);
        assert.doesNotMatch(out.get("tests/e2e/e2e.test.ts") ?? "", /createGrpcTransport/);
    });

    it("preserves source files and generates a README", () => {
        const out = transformBase(base, nodePnpm);
        assert.equal(out.get("src/services/greeterService.ts"), "export const greeterService = {};\n");
        // buf.gen.yaml is regenerated (es-only when no catalog).
        assert.match(out.get("buf.gen.yaml") ?? "", /protoc-gen-es/);
        assert.doesNotMatch(out.get("buf.gen.yaml") ?? "", /catalog/);
        assert.match(out.get("README.md") ?? "", /payments/);
    });

    it("transforms package.json (name, no private, testing dep)", () => {
        const pkg = JSON.parse(transformBase(base, nodePnpm).get("package.json") ?? "{}");
        assert.equal(pkg.name, "payments");
        assert.equal(pkg.private, undefined);
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.0.0");
    });

    it("emits a standalone pnpm-workspace.yaml (build-approval) for pnpm, not for npm", () => {
        const pnpmOut = transformBase(base, nodePnpm);
        // pnpm 11 honours `allowBuilds` (map), NOT `onlyBuiltDependencies` — see transform.ts.
        assert.match(pnpmOut.get("pnpm-workspace.yaml") ?? "", /allowBuilds:/);
        assert.match(pnpmOut.get("pnpm-workspace.yaml") ?? "", /'@bufbuild\/buf': true/);
        const npmOut = transformBase(base, { ...nodePnpm, packageManager: "npm" });
        assert.equal(npmOut.has("pnpm-workspace.yaml"), false);
    });
});
