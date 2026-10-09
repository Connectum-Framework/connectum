/**
 * Execute documentation examples as an isolated consumer of the packed candidate.
 * Run after build with sibling docs/examples checkouts:
 * pnpm docs:check --docs ../docs --examples ../examples
 *
 * The examples are extracted from Markdown rather than maintained as second copies.
 * The listening port is made ephemeral; the documented HTTP/1 variant is run
 * separately. An export exposes the example's server to the probe. The probe
 * checks responses, input boundaries and configured protocols, then cleans up.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packWorkspace } from "./lib/pack-workspace.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith("--"))) throw new Error(`--${name} requires a directory`);
    return resolve(index < 0 ? fallback : process.argv[index + 1]);
};
const docs = option("docs", join(repo, "../docs"));
const examples = option("examples", join(repo, "../examples"));
const keep = process.argv.includes("--keep");
mkdirSync(join(repo, ".tmp"), { recursive: true });
const work = mkdtempSync(join(repo, ".tmp/documentation-acceptance-"));
const outcomes = [];

function run(command, args, cwd) {
    console.log(`documentation-acceptance: ${command} ${args.join(" ")} (${cwd})`);
    execFileSync(command, args, { cwd, stdio: "inherit", timeout: 180_000, env: process.env });
}

function block(file, language, predicate) {
    const source = readFileSync(file, "utf8");
    const matches = [...source.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)].filter((match) => match[1] === language && predicate(match[2]));
    if (matches.length !== 1) throw new Error(`${file}: expected one ${language} example, found ${matches.length}`);
    return matches[0][2];
}

function write(directory, path, contents) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
}

function replaceOnce(source, before, after) {
    if (source.split(before).length !== 2) throw new Error(`Expected exactly one documented fragment: ${before}`);
    return source.replace(before, after);
}

function probe(directory, mode) {
    cpSync(join(repo, "scripts/documentation-acceptance/probe.mjs"), join(directory, "probe.mjs"));
    run(process.execPath, ["probe.mjs", mode], directory);
    outcomes.push({ mode, result: "passed" });
}

try {
    const tarballs = packWorkspace({ repoRoot: repo, dest: join(work, "tarballs"), build: false });
    const quickstart = join(work, "quickstart");
    const page = join(docs, "en/guide/quickstart.md");
    const manifest = JSON.parse(block(page, "json", (text) => text.includes('"start": "node src/index.ts"')));
    const base = JSON.parse(readFileSync(join(examples, "getting-started/package.json"), "utf8"));
    manifest.private = true;
    manifest.dependencies = {
        ...base.dependencies,
        "@connectrpc/connect-node": "^2.2.0",
        "@connectrpc/validate": "^0.2.0",
        "@bufbuild/protovalidate": "^1.3.0",
        jose: "^6.0.0",
        ...Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`])),
    };
    manifest.devDependencies = base.devDependencies;
    write(quickstart, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    write(
        quickstart,
        "pnpm-workspace.yaml",
        `packages:\n  - '.'\nallowBuilds:\n  '@bufbuild/buf': true\n  esbuild: true\n  protobufjs: true\noverrides:\n${[...tarballs].map(([name, path]) => `  '${name}': 'file:${path}'`).join("\n")}\n`,
    );
    write(
        quickstart,
        "tsconfig.json",
        block(page, "json", (text) => text.includes('"compilerOptions"')),
    );
    write(
        quickstart,
        "proto/greeter.proto",
        block(page, "protobuf", (text) => text.includes("service GreeterService")),
    );
    write(
        quickstart,
        "buf.yaml",
        block(page, "yaml", (text) => text.includes("modules:")),
    );
    write(
        quickstart,
        "buf.gen.yaml",
        block(page, "yaml", (text) => text.includes("plugins:")),
    );
    write(
        quickstart,
        "src/services/greeterService.ts",
        block(page, "typescript", (text) => text.includes("export const greeterService")),
    );
    const entry = block(page, "typescript", (text) => text.includes("await server.start()"));
    const ephemeralEntry = replaceOnce(entry, "port: 5000,", "port: 0,");
    write(quickstart, "src/index.ts", `${ephemeralEntry}\nexport { server };\n`);
    run("pnpm", ["install", "--no-frozen-lockfile"], quickstart);
    for (const [name, tarball] of tarballs) {
        const installed = realpathSync(join(quickstart, "node_modules", name));
        if (!installed.includes("@file+")) throw new Error(`${name} resolved outside the candidate tarball: ${installed}`);
        console.log(`candidate: ${name} <- ${tarball}`);
    }
    const buf = join(quickstart, "node_modules/.bin/buf");
    run(buf, ["dep", "update"], quickstart);
    run("pnpm", ["run", "build:proto"], quickstart);
    run("pnpm", ["run", "typecheck"], quickstart);
    probe(quickstart, "quickstart-h2c");
    write(quickstart, "src/index.ts", `${replaceOnce(ephemeralEntry, "allowHTTP1: false", "allowHTTP1: true")}\nexport { server };\n`);
    probe(quickstart, "quickstart-http1");

    for (const name of ["core", "healthcheck", "reflection", "interceptors", "auth", "otel"]) {
        const directory = join(work, `readme-${name}`);
        cpSync(join(examples, "getting-started"), directory, {
            recursive: true,
            filter: (path) => !/(?:^|\/)(?:node_modules|gen|\.git)(?:\/|$)/.test(path),
        });
        symlinkSync(join(quickstart, "node_modules"), join(directory, "node_modules"), "dir");
        const readme = join(repo, "packages", name, "README.md");
        write(
            directory,
            "src/server.ts",
            block(readme, "typescript", (text) => text.includes("export function buildServer")),
        );
        run(buf, ["generate"], directory);
        // Direct tool invocation avoids pnpm re-installing an example's published
        // dependency ranges over the deliberately linked candidate installation.
        run(process.execPath, [join(quickstart, "node_modules/typescript/bin/tsc"), "--noEmit"], directory);
        probe(directory, `readme-${name}`);
    }

    const test = "readme-testing.test.ts";
    write(
        quickstart,
        test,
        block(join(repo, "packages/testing/README.md"), "typescript", (text) => text.includes("node:test")),
    );
    run(process.execPath, ["--import", "tsx", "--test", test], quickstart);
    outcomes.push({ mode: "readme-testing", result: "passed" });
    const fixture = "readme-test-fixtures.mjs";
    write(
        quickstart,
        fixture,
        block(join(repo, "packages/test-fixtures/README.md"), "javascript", (text) => text.includes("createMockNext")),
    );
    const output = execFileSync(process.execPath, [fixture], { cwd: quickstart, encoding: "utf8", timeout: 15_000 });
    assert.deepEqual(output.trim().split(/\r?\n/), ["user-1", "1"]);
    outcomes.push({ mode: "readme-test-fixtures", result: "passed" });
    run(process.execPath, [join(repo, "scripts/documentation-acceptance/auth-tls.mjs"), "--docs", docs, "--candidate-dir", quickstart], repo);
    outcomes.push({ mode: "auth-tls-guides", result: "passed" });
    console.log(JSON.stringify({ work, outcomes }, null, 2));
} finally {
    if (keep) console.log(`documentation-acceptance: retained ${work}`);
    else rmSync(work, { recursive: true, force: true });
}
