/**
 * End-to-end type acceptance for service-catalog request initializers.
 *
 * Runs the real Buf plugin pipeline into a temporary fixture, then compiles a
 * strict consumer against the generated catalog and protobuf declarations.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repoRoot = resolve(packageRoot, "../..");
const fixtureSource = resolve(packageRoot, "tests/fixtures/request-initializers");
const coreRoot = resolve(repoRoot, "packages/core");
const bufBin = resolve(repoRoot, "packages/healthcheck/node_modules/.bin/buf");
const protocGenEs = resolve(repoRoot, "node_modules/.bin/protoc-gen-es");
const tsc = resolve(packageRoot, "node_modules/.bin/tsc");

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
    try {
        return execFileSync(command, args, {
            cwd,
            encoding: "utf8",
            env,
            maxBuffer: 8 * 1024 * 1024,
        });
    } catch (error) {
        const result = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
        assert.fail(
            `${command} ${args.join(" ")} failed in ${cwd}\n${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}\n${result.message ?? ""}`,
        );
    }
}

describe("protoc-gen-connectum-catalog request initializer acceptance", () => {
    it("packs core and the plugin, generates with Buf, and compiles strict consumer cases", () => {
        assert.ok(existsSync(resolve(coreRoot, "dist/index.d.ts")), "build @connectum/core before this integration test");
        assert.ok(existsSync(resolve(packageRoot, "dist/index.js")), "build @connectum/protoc-gen-catalog before this integration test");

        const scratchRoot = resolve(repoRoot, ".tmp");
        mkdirSync(scratchRoot, { recursive: true });
        const tempRoot = mkdtempSync(resolve(scratchRoot, "connectum-catalog-init-"));
        try {
            const packDir = resolve(tempRoot, "packs");
            const workDir = resolve(tempRoot, "consumer");
            mkdirSync(packDir);
            packPackage(coreRoot, packDir);
            packPackage(packageRoot, packDir);
            const packedCore = readdirSync(packDir).find((file) => file.startsWith("connectum-core-") && file.endsWith(".tgz"));
            const packedPlugin = readdirSync(packDir).find((file) => file.startsWith("connectum-protoc-gen-catalog-") && file.endsWith(".tgz"));
            assert.ok(packedCore, "pnpm pack produced the @connectum/core tarball");
            assert.ok(packedPlugin, "pnpm pack produced the generator tarball");

            mkdirSync(workDir);
            cpSync(fixtureSource, workDir, { recursive: true });
            // Keep typecheck inputs out of the workspace-wide source scan until this isolated consumer has generated imports.
            renameSync(resolve(workDir, "consumer.ts.fixture"), resolve(workDir, "consumer.ts"));
            renameSync(resolve(workDir, "runtime-consumer.ts.fixture"), resolve(workDir, "runtime-consumer.ts"));
            renameSync(resolve(workDir, "legacy/consumer.ts.fixture"), resolve(workDir, "legacy/consumer.ts"));
            const packedCoreRoot = resolve(tempRoot, "packed/core");
            const packedPluginRoot = resolve(tempRoot, "packed/plugin");
            mkdirSync(packedCoreRoot, { recursive: true });
            mkdirSync(packedPluginRoot, { recursive: true });
            run("tar", ["-xzf", resolve(packDir, packedCore), "-C", packedCoreRoot], tempRoot);
            run("tar", ["-xzf", resolve(packDir, packedPlugin), "-C", packedPluginRoot], tempRoot);
            const packedCorePackage = resolve(packedCoreRoot, "package");
            const packedPluginPackage = resolve(packedPluginRoot, "package");

            const consumerNodeModules = resolve(workDir, "node_modules");
            const packageNodeModules = [
                consumerNodeModules,
                resolve(packedCorePackage, "node_modules"),
                resolve(packedPluginPackage, "node_modules"),
            ];
            for (const modules of packageNodeModules) mkdirSync(modules, { recursive: true });

            const coreDeps: Array<[string, string]> = [
                ["@bufbuild/protobuf", resolve(packageRoot, "node_modules/@bufbuild/protobuf")],
                ["@types/node", resolve(repoRoot, "node_modules/@types/node")],
                ["@connectrpc/connect", resolve(coreRoot, "node_modules/@connectrpc/connect")],
                ["@connectrpc/connect-node", resolve(coreRoot, "node_modules/@connectrpc/connect-node")],
                ["env-var", resolve(coreRoot, "node_modules/env-var")],
                ["zod", resolve(coreRoot, "node_modules/zod")],
            ];
            const pluginDeps: Array<[string, string]> = [
                ["@bufbuild/protobuf", resolve(packageRoot, "node_modules/@bufbuild/protobuf")],
                ["@bufbuild/protoplugin", resolve(packageRoot, "node_modules/@bufbuild/protoplugin")],
            ];
            const consumerDeps: Array<[string, string]> = [
                ["@bufbuild/protobuf", resolve(packageRoot, "node_modules/@bufbuild/protobuf")],
                ["@types/node", resolve(repoRoot, "node_modules/@types/node")],
                ["@connectrpc/connect", resolve(coreRoot, "node_modules/@connectrpc/connect")],
                ["@connectrpc/connect-node", resolve(coreRoot, "node_modules/@connectrpc/connect-node")],
                ["@connectum/core", packedCorePackage],
                ["@connectum/protoc-gen-catalog", packedPluginPackage],
            ];
            for (const [modules, dependencies] of [
                [resolve(packedCorePackage, "node_modules"), coreDeps],
                [resolve(packedPluginPackage, "node_modules"), pluginDeps],
                [consumerNodeModules, consumerDeps],
            ] as const) {
                for (const [name, target] of dependencies) {
                    const link = resolve(modules, name);
                    mkdirSync(resolve(link, ".."), { recursive: true });
                    symlinkSync(target, link, "dir");
                }
            }

            for (const executable of [bufBin, protocGenEs, tsc, resolve(packedPluginPackage, "dist/index.js")]) {
                assert.ok(existsSync(executable), `installed consumer executable exists: ${executable}`);
            }

            const generatorTemplate = {
                version: "v2",
                clean: true,
                plugins: [
                    { local: protocGenEs, out: "gen", opt: ["target=ts", "import_extension=.ts"] },
                    { local: [process.execPath, resolve(packedPluginPackage, "dist/index.js")], out: "gen", strategy: "all", opt: ["target=ts", "import_extension=.ts"] },
                ],
            };
            writeFileSync(resolve(workDir, "buf.gen.yaml"), `${JSON.stringify(generatorTemplate, null, 2)}\n`);

            run(bufBin, ["generate", "--template", "buf.gen.yaml"], workDir);

            mkdirSync(resolve(workDir, "gen/legacy"), { recursive: true });
            renameSync(resolve(workDir, "legacy/catalog.gen.ts.fixture"), resolve(workDir, "gen/legacy/catalog.gen.ts"));

            const generatedCatalog = readFileSync(resolve(workDir, "gen/catalog.gen.ts"), "utf8");
            assert.ok((generatedCatalog.match(/MessageInitShape<typeof /g) ?? []).length >= 5);
            assert.match(generatedCatalog, /response: (?!MessageInitShape)/);
            assert.match(generatedCatalog, /kind: "server-stream"/);
            assert.match(generatedCatalog, /kind: "client-stream"/);
            assert.match(generatedCatalog, /kind: "bidi"/);

            run(tsc, ["--project", "tsconfig.json", "--pretty", "false"], workDir);
            run(tsc, ["--project", "legacy/tsconfig.json", "--pretty", "false"], workDir);
            const runtimeOutput = run(process.execPath, ["--experimental-strip-types", "runtime-consumer.ts"], workDir);
            assert.match(runtimeOutput, /Generated catalog dispatch accepted plain and full-message inputs for all RPC kinds\./);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

function packPackage(packagePath: string, packDir: string): void {
    run("pnpm", ["pack", "--pack-destination", packDir], packagePath);
}
